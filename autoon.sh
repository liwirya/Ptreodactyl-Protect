#!/bin/bash
source /etc/profile 2>/dev/null
source ~/.bashrc 2>/dev/null
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

APP_DIR="/root/xayz-monitor"
cd $APP_DIR

screen -wipe > /dev/null 2>&1
screen -S xayz-monitor -X quit > /dev/null 2>&1
screen -S xayz-monitor npm start
echo "✅ Bot Xayz-Monitor berhasil dihidupkan!"
