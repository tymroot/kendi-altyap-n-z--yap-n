"use strict";
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
const WebSocket = require('ws');
const tls = require('tls');
const fs = require('fs');
const config = {
    token: "",
    serverid: "1382033200934686864",
    logChannelId: "1386845398035075143"
};
const guilds = new Map();
const ownGuildVanities = new Set();
let mfa = null;
let lastSeq = null;
let hbInterval = null;
const tlsConnections = [];
let index = 0;
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Authorization': config.token,
    'Host': 'canary.discord.com',
    'Connection': 'keep-alive',
    'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6Ind3dy5nb29nbGUuY29tIiwic2VhcmNoX2VuZ2luZSI6Imdvb2dsZSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTYxNDAsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9'
};

function loadMfa() {
    try {
        if (fs.existsSync('./mfa_token.json')) {
            const fileContent = fs.readFileSync('./mfa_token.json', 'utf8').trim();
            if (fileContent) {
                const data = JSON.parse(fileContent);
                if (data.token) {
                    return data.token;
                }
            }
        }
    } catch (error) {
        return null;
    }
    return null;
}

function createSocket(id) {
    return new Promise((resolve) => {
        const socket = tls.connect({
            host: 'canary.discord.com',
            port: 443,
            ciphers: 'ECDHE-RSA-AES128-GCM-SHA256',
            secureProtocol: 'TLSv1_2_method'
        });
        socket.setKeepAlive(true, 0);
        socket.setNoDelay(true);
        socket.id = id;
        socket.ready = false;
        socket.on('secureConnect', () => {
            socket.ready = true;
            resolve(socket);
        });
        socket.on('close', () => {
            socket.ready = false;
            setTimeout(() => createSocket(id).then(s => tlsConnections[id] = s), 1000);
        });
        socket.on('error', () => {
            socket.ready = false;
            setTimeout(() => createSocket(id).then(s => tlsConnections[id] = s), 1000);
        });
    });
}

async function initSockets() {
    for (let i = 0; i < 12; i++) {
        tlsConnections[i] = await createSocket(i);
    }
}

function request(method, path, customHeaders = {}, body = null) {
    const socket = tlsConnections[index];
    index = (index + 1) % 12;
    return new Promise((resolve, reject) => {
        if (!socket || !socket.ready) {
            return reject(new Error('Socket not ready'));
        }
        const h = { ...headers, ...customHeaders };
        if (body) h['Content-Length'] = Buffer.byteLength(body);
        let req = `${method} ${path} HTTP/1.1\r\n`;
        Object.entries(h).forEach(([k, v]) => req += `${k}: ${v}\r\n`);
        req += '\r\n' + (body || '');
        let rawResponse = '';
        let done = false;
        const timeout = setTimeout(() => {
            if (!done) {
                done = true;
                socket.removeAllListeners('data');
                reject(new Error('Request timeout'));
            }
        }, 1000);
        const onData = (chunk) => {
            if (done) return;
            rawResponse += chunk.toString();
            if (rawResponse.includes('\r\n\r\n')) {
                const parts = rawResponse.split('\r\n\r\n');
                let bodyPart = parts.slice(1).join('\r\n\r\n');
                done = true;
                clearTimeout(timeout);
                socket.removeListener('data', onData);
                resolve(bodyPart);
            }
        };
        socket.on('data', onData);
        socket.write(req);
    });
}

function readMfaToken() {
    const saved = loadMfa();
    if (saved && saved !== mfa) {
        mfa = saved;
        console.log('mfa gecildi allahım');
    } else if (!saved && mfa) {
        mfa = null;
    }
}

function watchMfaFile() {
    if (fs.existsSync('./mfa_token.json')) {
        fs.watchFile('./mfa_token.json', { interval: 1000 }, readMfaToken);
    }
}

async function sendLog(message) {
    if (!config.logChannelId || !mfa) return;
    try {
        const body = JSON.stringify({ content: message });
        await request('POST', `/api/v9/channels/${config.logChannelId}/messages`, {
            'X-Discord-MFA-Authorization': mfa,
            'Content-Type': 'application/json'
        }, body);
    } catch {}
}

async function instantSnipe(url) {
    if (!mfa) return;
    
    const payload = JSON.stringify({ code: url });
    const snipeHeaders = {
        'X-Discord-MFA-Authorization': mfa,
        'Content-Type': 'application/json'
    };
    
    const requests = Array.from({ length: 12 }, () =>
        request('PATCH', `/api/v10/guilds/${config.serverid}/vanity-url`, snipeHeaders, payload)
            .then(res => {
                try {
                    const data = JSON.parse(res);
                    if (data.code === url) {
                        sendLog(`@everyone { code: "${url}", rateys: 0 }`);
                        return { success: true, data };
                    } else if (data.code === 10008) {
                        sendLog(`10008 bilinmeyen mesaj - ${url}`);
                        return { success: false, data };
                    } else {
                        sendLog(`davet kodu geçersiz veya kullanılmış - ${url}`);
                        return { success: false, data };
                    }
                } catch {
                    sendLog(`davet kodu geçersiz veya kullanılmış - ${url}`);
                    return { success: false, error: 'Parse error' };
                }
            })
            .catch(error => {
                sendLog(`davet kodu geçersiz veya kullanılmış - ${url}`);
                return { success: false, error: error.message };
            })
    );
    
    try {
        await Promise.race(requests);
    } catch {}
}

function connectWS() {
    const ws = new WebSocket('wss://gateway-us-east1-b.discord.gg');
    
    ws.on('open', () => {
        ws.send(JSON.stringify({
            op: 2,
            d: {
                token: config.token,
                intents: 1,
                properties: {
                    $os: "linux",
                    $browser: "",
                    $device: ""
                }
            }
        }));
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.s) lastSeq = msg.s;
            
            if (msg.op === 10) {
                clearInterval(hbInterval);
                hbInterval = setInterval(() => {
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                    }
                }, msg.d.heartbeat_interval * 0.65);
            }
            
            if (msg.op === 0) {
                if (msg.t === 'READY') {
                    const vanityGuilds = msg.d.guilds.filter(g => g.vanity_url_code);
                    vanityGuilds.forEach(g => {
                        guilds.set(g.id, g.vanity_url_code);
                        if (g.owner_id === msg.d.user.id ||
                            (g.permissions && (parseInt(g.permissions) & 8) === 8)) {
                            ownGuildVanities.add(g.vanity_url_code);
                        }
                        console.log(g.vanity_url_code);
                    });
                }
                
                if (msg.t === 'GUILD_UPDATE') {
                    const stored = guilds.get(msg.d.id);
                    if (stored && stored !== msg.d.vanity_url_code) {
                        console.log(stored);
                        setImmediate(() => instantSnipe(stored));
                    }
                    if (stored && !msg.d.vanity_url_code && ownGuildVanities.has(stored)) {
                        console.log(stored);
                        setImmediate(() => instantSnipe(stored));
                    }
                    if (msg.d.vanity_url_code) {
                        guilds.set(msg.d.id, msg.d.vanity_url_code);
                    } else {
                        guilds.delete(msg.d.id);
                    }
                }
                
                if (msg.t === 'GUILD_DELETE') {
                    const deletedGuild = guilds.get(msg.d.id);
                    if (deletedGuild) {
                        console.log(deletedGuild);
                        // Kick yedikten sonra sadece log at, snipe yapma
                        sendLog(`🚫 **SUNUCUDAN KICK YENDİK!** Vanity: \`${deletedGuild}\` - İstek atılmadı`);
                        guilds.delete(msg.d.id);
                    }
                }
            }
        } catch {}
    });
    
    ws.on('close', () => {
        clearInterval(hbInterval);
        setTimeout(connectWS, 1000);
    });
    
    ws.on('error', () => ws.close());
}

async function init() {
    await initSockets();
    readMfaToken();
    watchMfaFile();
    setInterval(readMfaToken, 5000);
    connectWS();
}

init();

process.on('SIGINT', () => {
    tlsConnections.forEach(s => s.destroy());
    process.exit(0);
});
