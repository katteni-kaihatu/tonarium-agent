$ErrorActionPreference = 'Continue'
while ($true) {
  & ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R tonarium-agent:80:127.0.0.1:43879 kokopi.me
  Start-Sleep -Seconds 5
}
