# Cardano Bot
Cardano trading bot



Stop the bots (recommended)
# See what’s running
npx pm2 list

# Stop your two bots by name
npx pm2 stop bot:ada-usdm bot:ada-strike

# Verify
npx pm2 list

Stop everything (if you started more apps)
npx pm2 stop all

Prevent them from coming back after reboot
# Remove the apps from PM2’s saved list
npx pm2 delete bot:ada-usdm bot:ada-strike

# Save current (now-empty) process list so it won’t resurrect on reboot
npx pm2 save

Optional cleanup / shutdown
# Clear old logs
npx pm2 flush

# Fully stop the PM2 daemon (only if you want to shut PM2 itself down)
npx pm2 kill


If your app names differ, run npx pm2 list and substitute the names/IDs you see.