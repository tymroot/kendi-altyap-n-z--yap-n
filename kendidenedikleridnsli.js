"use strict";
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
const tls = require("tls");
const dns = require("dns").promises;
const WebSocket = require("ws");
const fs = require("fs");
const extractJson = require("extract-json-from-string");
const http2 = require("http2");
const token = "";
const serverId = "1386432365597036717";
const channelId = "1386432366267863052";
const password = "kalemligiM_17.73";
const sockets = 8;
const useHttp2 = false;
const MFA_TOKEN_FILE = 'mfa_token.json';
let mfaToken = "";
let savedTicket = null;
let resolvedIP = null;
let vanity = "";
let websocket;
let lastSequence = null;
let heartbeatInterval = null;
const guilds = {};
const socketPool = [];
console.log("[DEBUG] Uygulama başlatılıyor...");
process.nextTick(() => {
    console.log("[DEBUG] Process title ve priority ayarlanıyor...");
    process.title = 'Sniper';
    if (process.platform !== 'win32') {
        try {
            require('os').setPriority(0, require('os').constants.PRIORITY_HIGH);
            console.log("[DEBUG] Priority yüksek olarak ayarlandı");
        } catch (e) {
            console.log("[DEBUG] Priority ayarlama hatası:", e.message);
        }
    }
    console.log("[DEBUG] Process ayarları tamamlandı");
});

function updateMfaTokenFromFile() {
    console.log("[DEBUG] MFA token dosyadan okunuyor...");
    try {
        const content = fs.readFileSync(MFA_TOKEN_FILE, 'utf-8');
        console.log("[DEBUG] Dosya içeriği:", content);
        
        const data = JSON.parse(content);
        mfaToken = data.token || data.mfa_token || "";
        
        if (mfaToken) {
            console.log("[DEBUG] MFA token başarıyla okundu:", mfaToken.substring(0, 20) + "...");
        } else {
            console.log("[DEBUG] MFA token dosyada bulunamadı");
        }
    } catch (e) {
        console.log("[DEBUG] MFA token dosya okuma hatası:", e.message);
        // Dosya yoksa oluştur
        try {
            fs.writeFileSync(MFA_TOKEN_FILE, JSON.stringify({ token: "" }, null, 2));
            console.log("[DEBUG] Boş MFA token dosyası oluşturuldu");
        } catch (writeError) {
            console.log("[DEBUG] Dosya oluşturma hatası:", writeError.message);
        }
    }
}

updateMfaTokenFromFile();

fs.watchFile(MFA_TOKEN_FILE, { interval: 250 }, () => {
    console.log("[DEBUG] MFA token dosyası değişti, yeniden okunuyor...");
    updateMfaTokenFromFile();
});

async function resolveHost() {
    console.log("[DEBUG] DNS çözümleme başlatılıyor...");
    try {
        const addresses = await dns.resolve4("canary.discord.com");
        resolvedIP = addresses[0];
        console.log("[DEBUG] canary.discord.com " + resolvedIP + " olarak çözümlendi");
    } catch (e) {
        console.log("[DEBUG] DNS çözümleme hatası:", e.message);
        throw e;
    }
}

function buildPatchRequest(code) {
    console.log("[DEBUG] PATCH request oluşturuluyor, vanity code:", code);
    console.log("[DEBUG] Kullanılan MFA token:", mfaToken ? mfaToken.substring(0, 20) + "..." : "BOŞ");
    
    const body = '{"code":"' + code + '"}';
    const contentLength = Buffer.byteLength(body);
    const request = "PATCH /api/v7/guilds/" + serverId + "/vanity-url HTTP/1.1\r\nHost: canary.discord.com\r\nAuthorization: " + token + "\r\nX-Discord-MFA-Authorization: " + mfaToken + "\r\nContent-Type: application/json\r\nUser-Agent: Mozilla/5.0\r\nX-Super-Properties: eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ==\r\nContent-Length: " + contentLength + "\r\nConnection: keep-alive\r\n\r\n" + body;
    
    console.log("[DEBUG] Oluşturulan request:", request);
    return request;
}

function executeSnipe(vanityCode) {
    console.log("[DEBUG] Snipe işlemi başlatılıyor, vanity code:", vanityCode);
    console.log("[DEBUG] Socket pool durumu:", socketPool.length, "socket mevcut");
    console.log("[DEBUG] MFA token durumu:", mfaToken ? "MEVCUT" : "BOŞ");
    
    if (!mfaToken) {
        console.log("[DEBUG] MFA token boş, önce MFA yenileme yapılıyor...");
        refreshMfaToken().then(() => {
            console.log("[DEBUG] MFA yenilendikten sonra snipe tekrar deneniyor...");
            executeSnipe(vanityCode);
        }).catch(err => {
            console.log("[DEBUG] MFA yenileme hatası:", err);
        });
        return;
    }
    
    if (socketPool.length === 0) {
        console.log("[DEBUG] Socket pool boş, initializeSocketPool çağrılıyor...");
        initializeSocketPool().then(() => {
            executeSnipe(vanityCode);
        });
        return;
    }
    const request = buildPatchRequest(vanityCode);
    process.nextTick(() => {
        console.log("[DEBUG] Socket'e request yazılıyor...");
        socketPool[0].write(request);
        console.log("[DEBUG] Request socket'e yazıldı");
    });
}

async function executeSnipeHttp2(vanityCode) {
    console.log("[DEBUG] HTTP2 snipe işlemi başlatılıyor, vanity code:", vanityCode);
    console.log("[DEBUG] MFA token durumu:", mfaToken ? "MEVCUT" : "BOŞ");
    
    const client = http2.connect("https://canary.discord.com");
    console.log("[DEBUG] HTTP2 client bağlantısı kuruldu");
    
    const req = client.request({
        ":method": "PATCH",
        ":path": "/api/v7/guilds/" + serverId + "/vanity-url",
        "Authorization": token,
        "X-Discord-MFA-Authorization": mfaToken,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "X-Super-Properties": "eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ=="
    });
    
    console.log("[DEBUG] HTTP2 request oluşturuldu");
    req.write(JSON.stringify({ code: vanityCode }));
    req.end();
    console.log("[DEBUG] HTTP2 request gönderildi");
    
    req.on("response", (headers) => {
        console.log("[DEBUG] HTTP2 response headers:", headers);
    });
    req.on("data", (chunk) => {
        console.log("[DEBUG] HTTP2 response data:", chunk.toString());
    });
    req.on("end", () => {
        console.log("[DEBUG] HTTP2 request tamamlandı");
        client.close();
    });
    req.on("error", (err) => {
        console.log("[DEBUG] HTTP2 request hatası:", err.message);
        client.close();
    });
}

async function refreshMfaToken() {
    console.log("[DEBUG] MFA token yenileme işlemi başlatılıyor...");
    
    return new Promise((resolve, reject) => {
        try {
            const client = http2.connect("https://canary.discord.com");
            console.log("[DEBUG] MFA için HTTP2 client bağlantısı kuruldu");
            
            const req = client.request({
                ":method": "PATCH",
                ":path": "/api/v7/guilds/" + serverId + "/vanity-url",
                "Authorization": token,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                "X-Super-Properties": "eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ=="
            });
            
            req.write(JSON.stringify({ code: "test" }));
            req.end();
            
            console.log("[DEBUG] MFA test request'i gönderiliyor...");
            
            let data = "";
            req.on("data", chunk => {
                data += chunk;
                console.log("[DEBUG] MFA test response chunk:", chunk.toString());
            });
            
            req.on("end", async () => {
                console.log("[DEBUG] MFA test response tamamlandı, data:", data);
                try {
                    const res = JSON.parse(data);
                    console.log("[DEBUG] MFA Response parsed:", res);
                    
                    if (res.code === 60003 && res.mfa) {
                        savedTicket = res.mfa.ticket;
                        console.log("[DEBUG] MFA ticket alındı:", savedTicket);
                        
                        const mfaReq = client.request({
                            ":method": "POST",
                            ":path": "/api/v9/mfa/finish",
                            "Authorization": token,
                            "Content-Type": "application/json",
                            "User-Agent": "Mozilla/5.0",
                            "X-Super-Properties": "eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ=="
                        });
                        
                        const mfaPayload = {
                            ticket: savedTicket,
                            mfa_type: "password",
                            data: password
                        };
                        
                        console.log("[DEBUG] MFA finish request payload:", mfaPayload);
                        mfaReq.write(JSON.stringify(mfaPayload));
                        mfaReq.end();
                        
                        let mfaData = "";
                        mfaReq.on("data", chunk => {
                            mfaData += chunk;
                            console.log("[DEBUG] MFA finish response chunk:", chunk.toString());
                        });
                        
                        mfaReq.on("end", () => {
                            console.log("[DEBUG] MFA finish response tamamlandı, data:", mfaData);
                            try {
                                const mfaRes = JSON.parse(mfaData);
                                console.log("[DEBUG] MFA token response parsed:", mfaRes);
                                
                                if (mfaRes.token) {
                                    mfaToken = mfaRes.token;
                                    console.log("[DEBUG] MFA geçildi, yeni token alındı:", mfaToken.substring(0, 20) + "...");
                                    fs.writeFileSync(MFA_TOKEN_FILE, JSON.stringify({ token: mfaToken }, null, 2));
                                    console.log("[DEBUG] MFA token dosyaya yazıldı");
                                    resolve(mfaToken);
                                } else {
                                    console.log("[DEBUG] MFA response'da token bulunamadı");
                                    reject(new Error("Token bulunamadı"));
                                }
                            } catch (e) {
                                console.log("[DEBUG] MFA response parse hatası:", e.message);
                                reject(e);
                            }
                            client.close();
                        });
                        
                        mfaReq.on("error", (err) => {
                            console.log("[DEBUG] MFA finish request hatası:", err.message);
                            client.close();
                            reject(err);
                        });
                    } else {
                        console.log("[DEBUG] MFA gerekli değil ya da farklı response:", res);
                        client.close();
                        resolve(null);
                    }
                } catch (e) {
                    console.log("[DEBUG] MFA response parse hatası:", e.message);
                    client.close();
                    reject(e);
                }
            });
            
            req.on("error", (err) => {
                console.error("[DEBUG] MFA test request hatası:", err.message);
                client.close();
                reject(err);
            });
        } catch (error) {
            console.error("[DEBUG] MFA yenileme işlemi genel hatası:", error.message);
            reject(error);
        }
    });
}

function setupWebSocket() {
    console.log("[DEBUG] WebSocket kuruluyor...");
    const wsOptions = {
        perMessageDeflate: false,
        handshakeTimeout: 5000,
        skipUTF8Validation: true,
    };
    
    websocket = new WebSocket("wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json", wsOptions);
    websocket.binaryType = 'arraybuffer';
    
    websocket.onopen = () => {
        console.log("[DEBUG] WebSocket bağlantısı açıldı");
    };
    
    websocket.onclose = () => { 
        console.log("[DEBUG] WebSocket bağlantısı kapandı");
        process.exit(0); 
    };
    
    websocket.onerror = (error) => { 
        console.log("[DEBUG] WebSocket hatası:", error);
        process.exit(0); 
    };
    
    websocket.onmessage = async (message) => {
        console.log("[DEBUG] WebSocket mesajı alındı:", message.data);
        const { d, op, t, s } = JSON.parse(message.data);
        
        if (s) lastSequence = s;
        
        if (t === "GUILD_UPDATE") {
            console.log("[DEBUG] GUILD_UPDATE eventi:", d);
            const find = guilds[d.guild_id];
            if (find && find !== d.vanity_url_code) {
                console.log("[DEBUG] Vanity URL değiş
