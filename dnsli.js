"use strict";
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const tls = require("tls");
const dns = require("dns").promises;
const WebSocket = require("ws");
const fs = require("fs");
const extractJson = require("extract-json-from-string");
const http2 = require("http2");

const token = "";
const serverId = "1379226210483048478";
const channelId = "1393073415551848639";
const password = "";
const sockets = 12;
const useHttp2 = false;

let mfaToken = "";
let savedTicket = null;
let resolvedIP = null;
let vanity = "";
let websocket;
let lastSequence = null;
let heartbeatInterval = null;
const guilds = {};
const socketPool = [];

process.nextTick(() => {
    process.title = 'Sniper';
    if (process.platform !== 'win32') {
        try {
            require('os').setPriority(0, require('os').constants.PRIORITY_HIGH);
        } catch (e) {}
    }
});

function updateMfaTokenFromFile() {
    try {
        const c = fs.readFileSync('mfatoken.txt', 'utf-8');
        try { mfaToken = JSON.parse(c).token.trim(); }
        catch { mfaToken = c.trim(); }
    } catch {}
}
updateMfaTokenFromFile();
fs.watchFile('mfatoken.txt', { interval: 250 }, updateMfaTokenFromFile);

async function resolveHost() {
    const addresses = await dns.resolve4("canary.discord.com");
    resolvedIP = addresses[0];
    console.log(`Resolved canary.discord.com to ${resolvedIP}`);
}

function buildPatchRequest(code) {
    const body = `{"code":"${code}"}`;
    const contentLength = Buffer.byteLength(body);
    return `PATCH /api/v7/guilds/${serverId}/vanity-url HTTP/1.1\r\nHost: canary.discord.com\r\nAuthorization: ${token}\r\nX-Discord-MFA-Authorization: ${mfaToken}\r\nContent-Type: application/json\r\nUser-Agent: Mozilla/5.0\r\nX-Super-Properties: eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ==\r\nContent-Length: ${contentLength}\r\nConnection: keep-alive\r\n\r\n${body}`;
}

function executeSnipe(vanityCode) {
    const request = buildPatchRequest(vanityCode);
    process.nextTick(() => {
        socketPool[0].write(request);
    });
}

async function executeSnipeHttp2(vanityCode) {
    const client = http2.connect("https://canary.discord.com");
    const req = client.request({
        ":method": "PATCH",
        ":path": `/api/v7/guilds/${serverId}/vanity-url`,
        "Authorization": token,
        "X-Discord-MFA-Authorization": mfaToken,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "X-Super-Properties": "eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ=="
    });
    req.write(JSON.stringify({ code: vanityCode }));
    req.end();
    req.on("response", (headers) => {});
    req.on("data", () => {});
    req.on("end", () => client.close());
    req.on("error", () => client.close());
}

async function initializeSocketPool() {
    await resolveHost();
    const promises = [];
    for (let i = 0; i < sockets; i++) {
        const promise = new Promise((resolve) => {
            const socket = tls.connect({
                host: resolvedIP,
                port: 443,
                servername: "canary.discord.com",
                minVersion: "TLSv1.3",
                maxVersion: "TLSv1.3",
                handshakeTimeout: 100,
                keepAlive: true,
                keepAliveInitialDelay: 100,
                noDelay: true,
                rejectUnauthorized: false,
                ciphers: "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256",
                secureOptions: require('constants').SSL_OP_NO_COMPRESSION | require('constants').SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION,
                highWaterMark: 16384,
                allowHalfOpen: false,
                session: undefined,
            });
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 300);
            socket.setTimeout(0);

            socket.on("secureConnect", () => {
                socketPool.push(socket);
                if (socketPool.length === 1) { setupWebSocket(); }
                resolve();
            });

            socket.on("data", (data) => {
                const ext = extractJson(data.toString());
                const find = ext.find((e) => e.code || e.message);
                if (find) {
                    console.log(find);
                    const requestBody = JSON.stringify({content: `@everyone ${vanity}\n\`\`\`json\n${JSON.stringify(find)}\`\`\``});
                    socket.write(`POST /api/v10/channels/${channelId}/messages HTTP/1.1\r\nHost: canary.discord.com\r\nAuthorization: ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n${requestBody}`);
                }
            });

            socket.on("error", () => { process.exit(0); });
            socket.on("close", () => { process.exit(0); });
        });
        promises.push(promise);
    }
    await Promise.allSettled(promises);
    setInterval(() => {
        socketPool.forEach(socket => {
            socket.write(`GET /api/v10/gateway HTTP/1.1\r\nHost: canary.discord.com\r\nAuthorization: ${token}\r\nConnection: keep-alive\r\n\r\n`);
        });
    }, 600);
}

function setupWebSocket() {
    const wsOptions = {
        perMessageDeflate: false,
        handshakeTimeout: 5000,
        skipUTF8Validation: true,
    };
    websocket = new WebSocket("wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json", wsOptions);
    websocket.binaryType = 'arraybuffer';
    websocket.onopen = () => {};
    websocket.onclose = () => { process.exit(0); };
    websocket.onerror = () => { process.exit(0); };
    websocket.onmessage = async (message) => {
        const { d, op, t } = JSON.parse(message.data);
        if (t === "GUILD_UPDATE") {
            const find = guilds[d.guild_id];
            if (find && find !== d.vanity_url_code) {
                if (useHttp2) await executeSnipeHttp2(find);
                else executeSnipe(find);
                vanity = `${find}`;
            }
            return;
        }
        if (t === "GUILD_DELETE") {
            const find = guilds[d.id];
            if (find) {
                if (useHttp2) await executeSnipeHttp2(find);
                else executeSnipe(find);
                vanity = `${find}`;
            }
            return;
        }
        if (t === "READY") {
            d.guilds.forEach((guild) => {
                if (guild.vanity_url_code) {
                    guilds[guild.id] = guild.vanity_url_code;
                }
            });
            console.log(guilds);
        }
        if (op === 10) {
            websocket.send(JSON.stringify({
                op: 2,
                d: {
                    token: token,
                    intents: 1,
                    properties: { os: "Windows", browser: "Chrome", device: "Desktop" }
                }
            }));
            setInterval(() => {
                websocket.send(JSON.stringify({ op: 1, d: lastSequence }));
            }, 30000);
        }
    };
}

async function refreshMfaToken() {
    try {
        const client = http2.connect("https://canary.discord.com");
        const req = client.request({
            ":method": "PATCH",
            ":path": `/api/v7/guilds/${serverId}/vanity-url`,
            "Authorization": token,
            "Content-Type": "application/json"
        });
        req.end();
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", async () => {
            const res = JSON.parse(data);
            if (res.code === 60003 && res.mfa) {
                savedTicket = res.mfa.ticket;
                const mfaReq = client.request({
                    ":method": "POST",
                    ":path": "/api/v9/mfa/finish",
                    "Content-Type": "application/json"
                });
                mfaReq.write(JSON.stringify({
                    ticket: savedTicket,
                    mfa_type: "password",
                    data: password
                }));
                mfaReq.end();
                let mfaData = "";
                mfaReq.on("data", chunk => mfaData += chunk);
                mfaReq.on("end", () => {
                    const mfaRes = JSON.parse(mfaData);
                    if (mfaRes.token) {
                        mfaToken = mfaRes.token;
                        console.log("MFA geçildi, yeni token alındı.");
                    }
                    client.close();
                });
            } else {
                client.close();
            }
        });
        req.on("error", () => client.close());
    } catch (error) {
        console.error("MFA refresh failed:", error.message);
    }
}

(async function initialize() {
    await initializeSocketPool();
})();
