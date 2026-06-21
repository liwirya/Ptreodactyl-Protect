const { Telegraf, Markup } = require('telegraf');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const os = require('os');
const fs = require('fs');
const axios = require('axios');
const config = require('./config');

const dbFile = './data.json';
let db = { 
    target: 'private', 
    groups: [], 
    cpuThreshold: 100, 
    cpuDurationMs: 60000, 
    warnMode: 'confirm',
    ramLimitGB: 10,
    diskPteroLimitGB: 12,
    diskOsLimitGB: 5,
    osScanIntervalMs: 100,
    apiScanIntervalMs: 1000,
    totalPunished: 0,
    panelUrl: config.PANEL_URL,
    ptla: config.PTLA_KEY,
    ptlc: config.PTLC_KEY
};

if (fs.existsSync(dbFile)) {
    let parsedData = JSON.parse(fs.readFileSync(dbFile));
    db = { ...db, ...parsedData };
} else {
    fs.writeFileSync(dbFile, JSON.stringify(db));
}

const saveDb = () => fs.writeFileSync(dbFile, JSON.stringify(db));

const bot = new Telegraf(config.TELEGRAM_TOKEN);
let reportInterval = null;
let cpuTracker = {};
const deletingUUIDs = new Set();
const pendingViolations = {};
let isWiping = false;

const escapeHTML = (str) => str ? str.toString().replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)) : '';

bot.use(async (ctx, next) => {
    if (ctx.message && ctx.message.new_chat_members) return next();
    
    if (ctx.from && ctx.from.id.toString() !== config.ADMIN_ID) {
        if (ctx.callbackQuery) {
            const intruder = ctx.from;
            const name = escapeHTML(intruder.username ? '@' + intruder.username : intruder.first_name);
            ctx.reply(`🚨 <a href="tg://user?id=${intruder.id}">${name}</a> (<code>${intruder.id}</code>)\n⚠️ <b>DILARANG MENEKAN TOMBOL INI! HANYA OWNER YANG DIIZINKAN.</b>`, { parse_mode: 'HTML' }).catch(()=>{});
            return ctx.answerCbQuery("❌ Akses Ditolak! Anda bukan Owner.", { show_alert: true }).catch(()=>{});
        }
        return;
    }
    return next();
});

bot.on('new_chat_members', async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    const isBotAdded = newMembers.some(member => member.id === ctx.botInfo.id);
    
    if (isBotAdded) {
        if (ctx.from.id.toString() !== config.ADMIN_ID) {
            try {
                await ctx.reply('❌ <b>AKSES DITOLAK!</b>\nHanya Owner yang diizinkan menambahkan saya ke dalam grup. Saya akan keluar otomatis.', { parse_mode: 'HTML' });
                await ctx.leaveChat();
            } catch(e) {}
        } else {
            try {
                await ctx.reply('✅ <b>SYSTEM CONNECTED</b>\nBot Monitoring Pterodactyl berhasil disambungkan ke grup ini oleh Owner.', { parse_mode: 'HTML' });
            } catch(e) {}
        }
    }
});

bot.telegram.setMyCommands([
    { command: 'monitoring', description: 'Tampilkan status sistem & panel' },
    { command: 'clearstorage', description: 'WIPE TOTAL /var/lib/pterodactyl/volumes' },
    { command: 'setptla', description: 'Atur API Key PTLA baru' },
    { command: 'setptlc', description: 'Atur API Key PTLC baru' },
    { command: 'setdomain', description: 'Atur URL Panel baru' },
    { command: 'laporan', description: 'Cek & hapus manual pelanggar' },
    { command: 'settimelaporan', description: 'Atur waktu laporan otomatis' },
    { command: 'setlaporan', description: 'Atur target pengiriman laporan' },
    { command: 'aturwarn', description: 'Atur aksi otomatis pelanggaran' },
    { command: 'setscan', description: 'Atur kecepatan scan OS (ms)' },
    { command: 'setcekapi', description: 'Atur kecepatan scan API (ms)' },
    { command: 'setcpu', description: 'Atur limit CPU dan waktu' },
    { command: 'setram', description: 'Atur limit RAM (GB) Instan' },
    { command: 'setdiskos', description: 'Atur limit 1 file OS (GB) Instan' },
    { command: 'setdiskptero', description: 'Atur limit Disk Panel (GB) Instan' },
    { command: 'ikatgb', description: 'Ikat grup untuk laporan' },
    { command: 'listgb', description: 'Lihat daftar grup terikat' }
]);

async function sendAlert(msg, opts) {
    let sent = [];
    if (db.target === 'private' || db.target === 'both') {
        try {
            let m = await bot.telegram.sendMessage(config.ADMIN_ID, msg, opts);
            sent.push({ chatId: m.chat.id, msgId: m.message_id });
        } catch(e){}
    }
    if (db.target === 'group' || db.target === 'both') {
        for (let gid of db.groups) {
            try {
                let m = await bot.telegram.sendMessage(gid, msg, opts);
                sent.push({ chatId: m.chat.id, msgId: m.message_id });
            } catch(e){}
        }
    }
    return sent;
}

function getSystemStatus() {
    return new Promise((resolve) => {
        exec("df -h / | awk 'NR==2 {print $5}' && free -m | awk 'NR==2{printf \"%.2f%%\\n\", $3*100/$2 }' && uptime -p", (error, stdout) => {
            if (error) {
                console.error(`Error eksekusi: ${error}`);
                resolve({ disk: 'Error', ram: 'Error', uptime: 'Error' });
                return;
            }
            
            const lines = stdout.trim().split('\n');
            resolve({ 
                disk: lines[0] || 'N/A', 
                ram: lines[1] || 'N/A', 
                uptime: lines[2] || 'N/A' 
            });
        });
    });
}

function countPteroPanels() {
    return new Promise((resolve) => {
        exec("ls -l /var/lib/pterodactyl/volumes 2>/dev/null | grep '^d' | wc -l", (err, stdout) => {
            resolve(stdout.trim() || '0');
        });
    });
}

const paginationState = {};

async function generateReportText(page = 1, uName = 'Admin', uId = config.ADMIN_ID) {
    const sys = await getSystemStatus();
    const pteroCount = await countPteroPanels();
    const cpuLoad = os.loadavg()[0].toFixed(2);
    
    const cpuLimitStr = db.cpuThreshold === 0 ? "Unlimited (Off)" : `> ${db.cpuThreshold}% (${db.cpuDurationMs / 1000}s)`;
    const ramLimitStr = `${db.ramLimitGB} GB`;
    const diskOsLimitStr = `${db.diskOsLimitGB} GB / File`;
    const diskPteroLimitStr = `${db.diskPteroLimitGB} GB / Panel`;
    const totalAction = db.totalPunished || 0;

    let serverListText = "";
    let totalPages = 1;
    let hasNext = false;
    let hasPrev = false;
    
    try {
        const api = axios.create({ baseURL: db.panelUrl + '/api/application', headers: { 'Authorization': `Bearer ${db.ptla}` } });
        const res = await api.get('/servers');
        const servers = res.data.data;
        
        if (servers.length === 0) {
            serverListText = "➤ <i>Tidak ada server aktif di panel.</i>\n";
        } else {
            const limit = 5;
            totalPages = Math.ceil(servers.length / limit);
            
            if (page > totalPages) page = totalPages;
            if (page < 1) page = 1;
            
            const startIndex = (page - 1) * limit;
            const endIndex = startIndex + limit;
            const displayServers = servers.slice(startIndex, endIndex);
            
            for (const srv of displayServers) {
                const attr = srv.attributes;
                const isSafe = (deletingUUIDs.has(attr.uuid) || pendingViolations[attr.uuid]) ? "🔴 BAHAYA" : "🟢 AMAN";
                const ownerTag = attr.user === 1 ? " [⭐ Admin]" : "";
                serverListText += `➤ [ID:${attr.id}] ${escapeHTML(attr.name)}${ownerTag} : ${isSafe}\n`;
            }
            
            hasNext = page < totalPages;
            hasPrev = page > 1;
        }
    } catch (e) {
        serverListText = "➤ <i>Gagal mengambil daftar server dari API Panel. Cek Setelan API.</i>\n";
    }

    const reportText = `<b><blockquote>━━━━━━━━━━━[MONITORING PTERODACTYL]━━━━━━━━━━━</blockquote></b>
<pre><code>[ STATUS SYSTEM VPS ]</code></pre>
➤ Runtime: ${sys.uptime}
➤ OS: ${os.type()} ${os.release()}
➤ VPS Disk: ${sys.disk}
➤ VPS RAM: ${sys.ram}
➤ VPS CPU: ${cpuLoad}%
➤ Total Panel: ${pteroCount} Panel

<pre><code>[ KONFIGURASI PROTEKSI ]</code></pre>
➤ Limit CPU: ${cpuLimitStr}
➤ Limit RAM: ${ramLimitStr}
➤ Limit Disk (Panel): ${diskPteroLimitStr}
➤ Limit Disk (OS Bom): ${diskOsLimitStr}
➤ Total Dieksekusi: ${totalAction} Kali

<pre><code>[ STATUS SERVER (Halaman ${page}/${totalPages}) ]</code></pre>
${serverListText}`;

    return { reportText, hasNext, hasPrev, page, totalPages };
}

function getPaginationKeyboard(hasPrev, hasNext, page) {
    const buttons = [];
    if (hasPrev) buttons.push(Markup.button.callback('⬅️ Prev', `page_${page - 1}`));
    if (hasNext) buttons.push(Markup.button.callback('Next ➡️', `page_${page + 1}`));
    
    return Markup.inlineKeyboard([
        buttons,
        [Markup.button.url('DEVELOPER', 'https://t.me/XYCoolcraft')]
    ]);
}

async function executePunishment(srvData, action, triggerBy) {
    const { uuid, reason, srvName, sid, usrId, usrName } = srvData;
    let apiSuccess = false;
    
    try {
        const api = axios.create({ baseURL: db.panelUrl + '/api/application', headers: { 'Authorization': `Bearer ${db.ptla}` } });
        if (sid !== "Unknown") {
            if (action === 'delete') {
                await api.delete(`/servers/${sid}/force`).catch(()=>{});
                
                if (usrId !== 1 && usrId !== "Unknown") {
                    await api.delete(`/users/${usrId}`).catch(()=>{});
                }
                
                exec(`rm -rf /var/lib/pterodactyl/volumes/${uuid} || rm -f /var/lib/pterodactyl/volumes/${uuid}`);
            } else if (action === 'suspend') {
                await api.post(`/servers/${sid}/suspend`).catch(()=>{});
            }
            apiSuccess = true;
        }
    } catch(e){}

    if (!apiSuccess && action === 'delete') {
        exec(`rm -rf /var/lib/pterodactyl/volumes/${uuid} || rm -f /var/lib/pterodactyl/volumes/${uuid}`);
    }

    if (!db.totalPunished) db.totalPunished = 0;
    db.totalPunished += 1;
    saveDb();

    let accountStatus = (usrId === 1) ? "⚠️ <i>Akun dilindungi (Admin ID 1)</i>" : "Musnah";
    if (action === 'suspend') accountStatus = "Ditangguhkan";

    const actionText = action === 'delete' ? 'DIHAPUS (DELETE)' : 'DITANGGUHKAN (SUSPEND)';
    const alertMsg = `✅ <b>TINDAKAN BERHASIL (${actionText})</b>\n➤ <b>Server Name:</b> ${escapeHTML(srvName)}\n➤ <b>Reason:</b> ${reason}\n➤ <b>Server ID:</b> ${sid}\n➤ <b>UUID:</b> <code>${uuid}</code>\n➤ <b>User ID:</b> ${usrId} (${accountStatus})\n➤ <b>Trigger:</b> ${triggerBy}\n\n🔔 <b>CC Owner:</b> <a href="tg://user?id=${config.ADMIN_ID}">Pemberitahuan Sistem</a>`;
    sendAlert(alertMsg, { parse_mode: 'HTML' });
    
    setTimeout(() => deletingUUIDs.delete(uuid), 60000);
}

async function triggerViolation(uuid, reason) {
    if (deletingUUIDs.has(uuid)) return;
    deletingUUIDs.add(uuid);

    if (db.warnMode === 'delete') {
        exec(`rm -rf /var/lib/pterodactyl/volumes/${uuid} || rm -f /var/lib/pterodactyl/volumes/${uuid}`);
    }

    let srvName = "Unknown", sid = "Unknown", usrId = "Unknown", usrName = "Unknown";
    try {
        const api = axios.create({ baseURL: db.panelUrl + '/api/application', headers: { 'Authorization': `Bearer ${db.ptla}` } });
        const search = await api.get(`/servers?filter[uuid]=${uuid}`);
        if (search.data && search.data.data.length > 0) {
            const srv = search.data.data[0].attributes;
            sid = srv.id; usrId = srv.user; srvName = srv.name;
            try {
                const usrReq = await api.get(`/users/${usrId}`);
                usrName = usrReq.data.attributes.username;
            } catch(e){}
        }
    } catch(e){}

    const srvData = { uuid, reason, srvName, sid, usrId, usrName };

    if (db.warnMode === 'delete') {
        await executePunishment(srvData, 'delete', 'Auto-Delete (Settings)');
    } else if (db.warnMode === 'suspend') {
        await executePunishment(srvData, 'suspend', 'Auto-Suspend (Settings)');
    } else {
        const kb = Markup.inlineKeyboard([
            [Markup.button.callback('🛑 SUSPEND', `punish_suspend_${uuid}`), Markup.button.callback('🗑 DELETE', `punish_delete_${uuid}`)],
            [Markup.button.url('DEVELOPER', 'https://t.me/XYCoolcraft')]
        ]);
        
        const msgText = `🚨 <b>MENDETEKSI PELANGGARAN:</b>\n➤ <b>Server:</b> ${escapeHTML(srvName)}\n➤ <b>Reason:</b> ${reason}\n➤ <b>UUID:</b> <code>${uuid}</code>\n\n⏳ <i>Menunggu respon Owner (3 detik) sebelum Auto-Delete...</i>\n\n🔔 <b>CC Owner:</b> <a href="tg://user?id=${config.ADMIN_ID}">Peringatan Sistem</a>`;
        const sentMsgs = await sendAlert(msgText, { parse_mode: 'HTML', ...kb });
        
        const timeout = setTimeout(async () => {
            if (pendingViolations[uuid]) {
                await executePunishment(srvData, 'delete', 'Auto-Delete (No Response > 3s)');
                for (let m of sentMsgs) {
                    bot.telegram.editMessageText(m.chatId, m.msgId, null, `✅ <b>WAKTU HABIS (3 Detik)!</b>\nServer ${escapeHTML(srvName)} telah otomatis di-DELETE karena Pelanggaran: ${reason}\n\n🔔 <b>CC Owner:</b> <a href="tg://user?id=${config.ADMIN_ID}">Sistem Dieksekusi</a>`, { parse_mode: 'HTML' }).catch(()=>{});
                }
                delete pendingViolations[uuid];
            }
        }, 3000);

        pendingViolations[uuid] = { srvData, timeout, sentMsgs };
    }
}

async function processViolations(stdout, reason) {
    if (!stdout || !stdout.trim()) return;
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
        const match = line.match(/\/volumes\/([a-f0-9\-]+)/);
        if (match) {
            await triggerViolation(match[1], reason);
        }
    }
}

async function checkPanelResources() {
    try {
        const apiApp = axios.create({ baseURL: db.panelUrl + '/api/application', headers: { 'Authorization': `Bearer ${db.ptla}` } });
        const serversRes = await apiApp.get('/servers');
        const servers = serversRes.data.data;
        const apiClient = axios.create({ baseURL: db.panelUrl + '/api/client', headers: { 'Authorization': `Bearer ${db.ptlc}` } });
        
        for (const srv of servers) {
            const attr = srv.attributes;
            if (deletingUUIDs.has(attr.uuid)) continue;
            try {
                const res = await apiClient.get(`/servers/${attr.identifier}/resources`);
                const stats = res.data.attributes.resources;
                
                const diskLimit = db.diskPteroLimitGB * 1024 * 1024 * 1024;
                const ramLimit = db.ramLimitGB * 1024 * 1024 * 1024;
                
                if (stats.disk_bytes >= diskLimit || stats.memory_bytes >= ramLimit) {
                    let failReason = stats.disk_bytes >= diskLimit ? `Disk Limit Panel >= ${db.diskPteroLimitGB}GB` : `RAM Limit >= ${db.ramLimitGB}GB`;
                    await triggerViolation(attr.uuid, failReason);
                    continue;
                }
                
                if (db.cpuThreshold > 0 && stats.cpu_absolute > db.cpuThreshold) {
                    if (!cpuTracker[attr.uuid]) {
                        cpuTracker[attr.uuid] = Date.now();
                    } else if (Date.now() - cpuTracker[attr.uuid] >= db.cpuDurationMs) {
                        let durStr = db.cpuDurationMs >= 60000 ? (db.cpuDurationMs / 60000) + 'm' : (db.cpuDurationMs / 1000) + 's';
                        await triggerViolation(attr.uuid, `CPU > ${db.cpuThreshold}% (Selama ${durStr})`);
                        delete cpuTracker[attr.uuid];
                    }
                } else {
                    delete cpuTracker[attr.uuid];
                }
            } catch (e) {}
        }
    } catch (e) {}
}

async function checkEmergencyDisk() {
    if(isWiping) return;
    try {
        const { stdout } = await execPromise("df /var/lib/pterodactyl/volumes 2>/dev/null || df / | awk 'NR==2 {print $5}' | sed 's/%//'");
        const usage = parseInt(stdout.trim());
        if (usage >= 87) {
            isWiping = true;
            await execPromise('rm -rf /var/lib/pterodactyl/volumes/* || rm -f /var/lib/pterodactyl/volumes/*').catch(()=>{});
            sendAlert("🚨 <b>EMERGENCY PROTOCOL AKTIF (DISK WIPE)!</b> 🚨\nDisk VPS mencapai titik kritis (" + usage + "%). Seluruh folder volumes panel telah DIHAPUS TOTAL demi menyelamatkan OS!\n\n🔔 <b>CC Owner:</b> <a href=\"tg://user?id=" + config.ADMIN_ID + "\">Peringatan Darurat</a>", { parse_mode: 'HTML' });
            setTimeout(() => { isWiping = false; }, 10000);
        }
    } catch(e){}
    setTimeout(checkEmergencyDisk, 2000);
}

async function runOsScanner() {
    try {
        await Promise.all([
            execPromise('pkill -9 -f "fallocate" 2>/dev/null').catch(()=>{}),
            execPromise('pkill -9 -f "dd if=" 2>/dev/null').catch(()=>{}),
            execPromise(`find /var/lib/pterodactyl/volumes -type f -size +${db.diskOsLimitGB}G 2>/dev/null`)
                .then(async ({stdout}) => {
                    if (stdout) await processViolations(stdout, `Bom File Instan > ${db.diskOsLimitGB}GB (OS Level)`);
                }).catch(()=>{}),
            execPromise(`du -sh /var/lib/pterodactyl/volumes/* 2>/dev/null | grep 'G\\b' | awk '$1+0 >= ${db.diskPteroLimitGB} {print $2}'`)
                .then(async ({stdout}) => {
                    if (stdout) await processViolations(stdout, `Total Folder OS >= ${db.diskPteroLimitGB}GB`);
                }).catch(()=>{})
        ]);
    } catch(e) {}
    setTimeout(runOsScanner, db.osScanIntervalMs); 
}

async function runApiScanner() {
    await checkPanelResources();
    setTimeout(runApiScanner, db.apiScanIntervalMs); 
}

runOsScanner();
runApiScanner();
checkEmergencyDisk();

const keyboardMenu = Markup.inlineKeyboard([[Markup.button.url('DEVELOPER', 'https://t.me/XYCoolcraft')]]);

bot.command(['start', 'menu', 'help'], async (ctx) => {
    if (ctx.from.id.toString() !== config.ADMIN_ID) {
        return ctx.reply("🚫 <b>AKSES DITOLAK!</b>\nMaaf, Anda bukan Owner (Administrator) dari bot ini.", { parse_mode: 'HTML' });
    }

    const firstName = escapeHTML(ctx.from.first_name || 'Admin');
    const userName = ctx.from.username ? '@' + escapeHTML(ctx.from.username) : '<i>Tidak disetel</i>';
    const userId = ctx.from.id;

    const menuText = `<b><blockquote>━━━━━━━━━━━[ MONITORING VPS + Pterodactyl ]━━━━━━━━━━━</blockquote></b>
👋 いらっしゃいませ, <b>${firstName}</b> で <b>Monitorimg VPS + Panel Pterodactyl 保護</b>!
Pterodactyl VPS監視・保護システム.

<pre><code>[ YOUR INFO ]</code></pre>
➤ Nama: ${firstName}
➤ Username: ${userName}
➤ ID Telegram: <code>${userId}</code>

<pre><code>[ MENU ]</code></pre>
➤ /monitoring
➤ /clearstorage
➤ /laporan 
➤ /aturwarn
➤ /setscan
➤ /setcekapi
➤ /setcpu
➤ /setram
➤ /setdiskos
➤ /setdiskptero
➤ /settimelaporan
➤ /setlaporan
➤ /ikatgb 
➤ /listgb 
➤ /setptla [key] 
➤ /setptlc [key] 
➤ /setdomain [url] 

<i>Created And Developer By: @XYCoolcraft </i>
<b><blockquote>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</blockquote></b>`;

    if (config.THUMBNAIL) {
        await ctx.replyWithPhoto({ url: config.THUMBNAIL }, { caption: menuText, parse_mode: 'HTML', ...keyboardMenu });
    } else {
        await ctx.reply(menuText, { parse_mode: 'HTML', ...keyboardMenu });
    }
});

bot.command('monitoring', async (ctx) => {
    await ctx.reply("⏳ <i>Mengambil data dari VPS dan API Pterodactyl...</i>", { parse_mode: 'HTML' }).then(async (msgInfo) => {
        const { reportText, hasNext, hasPrev, page } = await generateReportText(1, ctx.from?.first_name, ctx.from?.id);
        const kb = getPaginationKeyboard(hasPrev, hasNext, page);
        
        await ctx.reply(reportText, { parse_mode: 'HTML', ...kb });
        
        bot.telegram.deleteMessage(ctx.chat.id, msgInfo.message_id).catch(()=>{});
    });
});

bot.action(/page_(\d+)/, async (ctx) => {
    const newPage = parseInt(ctx.match[1]);
    const { reportText, hasNext, hasPrev, page } = await generateReportText(newPage, ctx.from?.first_name, ctx.from?.id);
    const kb = getPaginationKeyboard(hasPrev, hasNext, page);
    
    ctx.editMessageText(reportText, { parse_mode: 'HTML', ...kb }).catch(()=>{});
    ctx.answerCbQuery().catch(()=>{});
});

bot.command('setptla', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) return ctx.reply("❌ Format: `/setptla [KeyPTLA]`", { parse_mode: 'Markdown' });
    db.ptla = args[0]; saveDb();
    ctx.reply("✅ <b>PTLA Key berhasil diubah!</b>", { parse_mode: 'HTML' });
});

bot.command('setptlc', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) return ctx.reply("❌ Format: `/setptlc [KeyPTLC]`", { parse_mode: 'Markdown' });
    db.ptlc = args[0]; saveDb();
    ctx.reply("✅ <b>PTLC Key berhasil diubah!</b>", { parse_mode: 'HTML' });
});

bot.command('setdomain', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) return ctx.reply("❌ Format: `/setdomain [url]`", { parse_mode: 'Markdown' });
    db.panelUrl = args[0].replace(/\/$/, ""); saveDb();
    ctx.reply(`✅ <b>URL Panel berhasil diubah ke:</b> ${db.panelUrl}`, { parse_mode: 'HTML' });
});

bot.command('clearstorage', async (ctx) => {
    ctx.reply("⚠️ <b>PERINGATAN!</b> ⚠️\nApakah Anda yakin ingin MENGHAPUS SELURUH file dan folder di dalam /var/lib/pterodactyl/volumes ini?\nIni tidak dapat dibatalkan!", {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ YA, HAPUS SEMUA!', callback_data: 'confirm_nuclear' }],
                [{ text: '❌ BATALKAN', callback_data: 'cancel_nuclear' }]
            ]
        }
    });
});

bot.action('confirm_nuclear', async (ctx) => {
    ctx.editMessageText("⏳ <b>Mengeksekusi Penghapusan Total...</b>", { parse_mode: 'HTML' }).catch(()=>{});
    try {
        await execPromise('rm -rf /var/lib/pterodactyl/volumes/* || rm -f /var/lib/pterodactyl/volumes/*');
        ctx.editMessageText("✅ <b>STORAGE BERHASIL DIBERSIHKAN!</b>\nSeluruh data server di `/var/lib/pterodactyl/volumes` telah dimusnahkan.\n\n🔔 <b>CC Owner:</b> <a href=\"tg://user?id=" + config.ADMIN_ID + "\">Perhatian</a>", { parse_mode: 'HTML' }).catch(()=>{});
    } catch(e) {
        ctx.editMessageText("❌ Terjadi kesalahan saat menghapus storage.", { parse_mode: 'HTML' }).catch(()=>{});
    }
});

bot.action('cancel_nuclear', (ctx) => { ctx.editMessageText("✅ <b>Aksi Dibatalkan.</b> Data aman.", { parse_mode: 'HTML' }).catch(()=>{}); });

bot.command('laporan', async (ctx) => {
    await ctx.reply("⏳ Memindai manual secara Live...");
    exec(`find /var/lib/pterodactyl/volumes -type f -size +${db.diskOsLimitGB}G 2>/dev/null`, (err, stdout) => {
        if (!stdout || !stdout.trim()) ctx.reply(`✅ Bersih: Tidak ada file > ${db.diskOsLimitGB}GB di OS.`);
        else processViolations(stdout, `Ditemukan file >= ${db.diskOsLimitGB}GB`);
    });
    exec(`du -sh /var/lib/pterodactyl/volumes/* 2>/dev/null | grep 'G\\b' | awk '$1+0 >= ${db.diskPteroLimitGB} {print $2}'`, (err, stdout) => {
        if (stdout && stdout.trim()) processViolations(stdout, `Penggunaan Disk OS >= ${db.diskPteroLimitGB}GB`);
    });
    await checkPanelResources();
});

bot.command('setscan', (ctx) => {
    ctx.reply('⚙️ <b>Pilih Kecepatan OS Scanner (Milidetik)</b>', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '1ms', callback_data: 'setscan_1' }, { text: '2ms', callback_data: 'setscan_2' }, { text: '3ms', callback_data: 'setscan_3' }, { text: '4ms', callback_data: 'setscan_4' }, { text: '5ms', callback_data: 'setscan_5' }],
                [{ text: '6ms', callback_data: 'setscan_6' }, { text: '7ms', callback_data: 'setscan_7' }, { text: '8ms', callback_data: 'setscan_8' }, { text: '9ms', callback_data: 'setscan_9' }, { text: '10ms [👍]', callback_data: 'setscan_10' }],
                [{ text: '20ms', callback_data: 'setscan_20' }, { text: '30ms', callback_data: 'setscan_30' }, { text: '40ms', callback_data: 'setscan_40' }, { text: '50ms', callback_data: 'setscan_50' }, { text: '60ms', callback_data: 'setscan_60' }],
                [{ text: '70ms', callback_data: 'setscan_70' }, { text: '80ms', callback_data: 'setscan_80' }, { text: '90ms', callback_data: 'setscan_90' }, { text: '100ms [👍]', callback_data: 'setscan_100' }, { text: '200ms', callback_data: 'setscan_200' }],
                [{ text: '300ms', callback_data: 'setscan_300' }, { text: '400ms', callback_data: 'setscan_400' }, { text: '500ms', callback_data: 'setscan_500' }]
            ]
        }
    });
});

bot.action(/setscan_(\d+)/, (ctx) => {
    db.osScanIntervalMs = parseInt(ctx.match[1]);
    saveDb();
    ctx.editMessageText(`✅ <b>Kecepatan OS Scanner berhasil diatur ke:</b> ${db.osScanIntervalMs}ms`, { parse_mode: 'HTML' }).catch(()=>{});
});

bot.command('setcekapi', (ctx) => {
    ctx.reply('⚙️ <b>Pilih Kecepatan API Scanner (Milidetik)</b>', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '10ms', callback_data: 'setcekapi_10' }, { text: '20ms', callback_data: 'setcekapi_20' }, { text: '30ms', callback_data: 'setcekapi_30' }, { text: '40ms', callback_data: 'setcekapi_40' }, { text: '50ms', callback_data: 'setcekapi_50' }],
                [{ text: '60ms', callback_data: 'setcekapi_60' }, { text: '70ms', callback_data: 'setcekapi_70' }, { text: '80ms', callback_data: 'setcekapi_80' }, { text: '90ms', callback_data: 'setcekapi_90' }, { text: '100ms [👍]', callback_data: 'setcekapi_100' }],
                [{ text: '200ms', callback_data: 'setcekapi_200' }, { text: '300ms', callback_data: 'setcekapi_300' }, { text: '400ms', callback_data: 'setcekapi_400' }, { text: '500ms', callback_data: 'setcekapi_500' }, { text: '600ms', callback_data: 'setcekapi_600' }],
                [{ text: '700ms', callback_data: 'setcekapi_700' }, { text: '800ms', callback_data: 'setcekapi_800' }, { text: '900ms', callback_data: 'setcekapi_900' }, { text: '1000ms [👍]', callback_data: 'setcekapi_1000' }, { text: '2000ms', callback_data: 'setcekapi_2000' }]
            ]
        }
    });
});

bot.action(/setcekapi_(\d+)/, (ctx) => {
    db.apiScanIntervalMs = parseInt(ctx.match[1]);
    saveDb();
    ctx.editMessageText(`✅ <b>Kecepatan API Scanner berhasil diatur ke:</b> ${db.apiScanIntervalMs}ms`, { parse_mode: 'HTML' }).catch(()=>{});
});

bot.command('aturwarn', (ctx) => {
    ctx.reply('⚙️ <b>Pilih Aksi Otomatis Jika Terdeteksi Pelanggaran:</b>', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Perlu Konfirmasi (3s)', callback_data: 'setwarn_confirm' }],
                [{ text: 'Langsung Delete Saja', callback_data: 'setwarn_delete' }],
                [{ text: 'Langsung Suspend Saja', callback_data: 'setwarn_suspend' }]
            ]
        }
    });
});

bot.action(/setwarn_(confirm|delete|suspend)/, (ctx) => {
    db.warnMode = ctx.match[1];
    saveDb();
    const modes = { 'confirm': 'Perlu Konfirmasi (3 Detik)', 'delete': 'Langsung Delete Saja', 'suspend': 'Langsung Suspend Saja' };
    ctx.editMessageText(`✅ <b>Aksi Otomatis berhasil diubah ke:</b> ${modes[db.warnMode]}`, { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/punish_(suspend|delete)_(.+)/, async (ctx) => {
    const action = ctx.match[1];
    const uuid = ctx.match[2];
    const pending = pendingViolations[uuid];
    if (pending) {
        clearTimeout(pending.timeout);
        await executePunishment(pending.srvData, action, `Tindakan Manual Owner (${action.toUpperCase()})`);
        try {
            await ctx.editMessageText(`✅ <b>TINDAKAN DIPILIH: ${action.toUpperCase()}</b>\nServer ${escapeHTML(pending.srvData.srvName)} sedang diproses...`, { parse_mode: 'HTML' });
        } catch(e){}
        delete pendingViolations[uuid];
    } else {
        ctx.answerCbQuery("⚠️ Tindakan sudah diproses atau kadaluarsa.", { show_alert: true }).catch(()=>{});
        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e){}
    }
});

bot.command('setlaporan', (ctx) => {
    ctx.reply('Pilih target pengiriman laporan & peringatan:', Markup.inlineKeyboard([
        [Markup.button.callback('Private Chat Saja', 'target_private')],
        [Markup.button.callback('Grup Saja', 'target_group')],
        [Markup.button.callback('Private + Grup', 'target_both')]
    ]));
});

bot.action(/target_(.+)/, (ctx) => {
    db.target = ctx.match[1];
    saveDb();
    ctx.editMessageText(`✅ Target laporan berhasil diatur ke: <b>${db.target.toUpperCase()}</b>`, { parse_mode: 'HTML' });
});

bot.command('setcpu', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 2) return ctx.reply("❌ <b>Format salah!</b>\n➤ Gunakan: <code>/setcpu &lt;limit&gt;% &lt;waktu&gt;&lt;s/m&gt;</code>", { parse_mode: 'HTML' });
    let limitStr = args[0].replace('%', '');
    let timeStr = args[1];
    let limit = parseFloat(limitStr);
    if (isNaN(limit) || limit < 0) return ctx.reply("❌ Limit CPU tidak valid.");
    let timeVal = parseInt(timeStr.replace(/[sm]/g, ''));
    let timeUnit = timeStr.slice(-1);
    let durationMs = 0;
    if (isNaN(timeVal) || timeVal <= 0) return ctx.reply("❌ Waktu tidak valid.");
    if (timeUnit === 's') durationMs = timeVal * 1000;
    else if (timeUnit === 'm') durationMs = timeVal * 60000;
    else return ctx.reply("❌ Gunakan 's' (detik) atau 'm' (menit).");
    
    db.cpuThreshold = limit;
    db.cpuDurationMs = durationMs;
    saveDb();
    if (limit === 0) ctx.reply("✅ Proteksi CPU dinonaktifkan (Unlimited).");
    else ctx.reply(`✅ Proteksi CPU diatur ke: <b>> ${limit}%</b> selama <b>${timeStr}</b>.`, { parse_mode: 'HTML' });
});

bot.command('setram', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 1 || isNaN(parseFloat(args[0]))) return ctx.reply("❌ Format: <code>/setram &lt;angka GB&gt;</code>\nContoh: <code>/setram 10</code>", { parse_mode: 'HTML' });
    db.ramLimitGB = parseFloat(args[0]);
    saveDb();
    ctx.reply(`✅ Limit RAM Instan diatur ke: <b>${db.ramLimitGB} GB</b>`, { parse_mode: 'HTML' });
});

bot.command('setdiskos', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 1 || isNaN(parseFloat(args[0]))) return ctx.reply("❌ Format: <code>/setdiskos &lt;angka GB&gt;</code>\nContoh: <code>/setdiskos 5</code>", { parse_mode: 'HTML' });
    db.diskOsLimitGB = parseFloat(args[0]);
    saveDb();
    ctx.reply(`✅ Limit Ukuran 1 File OS (Bom File) diatur ke: <b>${db.diskOsLimitGB} GB</b>`, { parse_mode: 'HTML' });
});

bot.command('setdiskptero', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 1 || isNaN(parseFloat(args[0]))) return ctx.reply("❌ Format: <code>/setdiskptero &lt;angka GB&gt;</code>\nContoh: <code>/setdiskptero 12</code>", { parse_mode: 'HTML' });
    db.diskPteroLimitGB = parseFloat(args[0]);
    saveDb();
    ctx.reply(`✅ Limit Total Disk Panel/Folder diatur ke: <b>${db.diskPteroLimitGB} GB</b>`, { parse_mode: 'HTML' });
});

bot.command('ikatgb', (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('❌ Perintah ini hanya bisa digunakan di dalam Grup.');
    if (!db.groups.includes(ctx.chat.id)) {
        db.groups.push(ctx.chat.id);
        saveDb();
        ctx.reply(`✅ Grup ini berhasil diikat.\n➤ ID Grup: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
    } else {
        ctx.reply('⚠️ Grup ini sudah terikat sebelumnya.');
    }
});

bot.command('listgb', async (ctx) => {
    if (db.groups.length === 0) return ctx.reply('📂 Tidak ada grup yang diikat.');
    let msg = '<b>Daftar Grup Terikat:</b>\n\n';
    for (let i = 0; i < db.groups.length; i++) {
        try {
            let chat = await bot.telegram.getChat(db.groups[i]);
            msg += `➤ ${escapeHTML(chat.title)} (<code>${chat.id}</code>)\n`;
        } catch (e) {
            msg += `➤ Tidak diketahui (<code>${db.groups[i]}</code>)\n`;
        }
    }
    ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('settimelaporan', (ctx) => {
    ctx.reply('Pilih interval waktu KILAS LAPORAN RUTIN (dalam menit):', Markup.inlineKeyboard([
        [Markup.button.callback('5m', 'set_5'), Markup.button.callback('10m', 'set_10'), Markup.button.callback('15m', 'set_15')],
        [Markup.button.callback('20m', 'set_20'), Markup.button.callback('25m', 'set_25'), Markup.button.callback('30m', 'set_30')],
        [Markup.button.callback('35m', 'set_35'), Markup.button.callback('40m', 'set_40'), Markup.button.callback('45m', 'set_45')],
        [Markup.button.callback('50m', 'set_50'), Markup.button.callback('55m', 'set_55'), Markup.button.callback('60m', 'set_60')],
        [Markup.button.callback('❌ Matikan Laporan', 'set_off')]
    ]));
});

bot.action(/set_(\d+|off)/, (ctx) => {
    const val = ctx.match[1];
    if (reportInterval) clearInterval(reportInterval);
    if (val === 'off') {
        ctx.editMessageText('❌ Pengiriman laporan rutin dimatikan. (Pemantauan sistem tetap berjalan Real-Time)').catch(()=>{});
    } else {
        const minutes = parseInt(val);
        ctx.editMessageText(`✅ Laporan rutin akan dikirim setiap ${minutes} menit. (Pemantauan sistem tetap berjalan Real-Time)`).catch(()=>{});
        reportInterval = setInterval(async () => {
            const { reportText } = await generateReportText(1, 'Auto-System', config.ADMIN_ID);
            sendAlert("📊 <b>LAPORAN RUTIN SISTEM:</b>\n" + reportText, { parse_mode: 'HTML' });
        }, minutes * 60 * 1000);
    }
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

