const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
const PORT = 3001;

const AUTH_KEY = 'MDE5ZDZjNzQtNTVkMC03NDFmLTgxMmUtNWRhZWNiZjIwNzY1OjNiYzQwMjc3LWNiYjQtNGI2NS1hNzY4LTI3ZDAwMDM1MzZlMQ==';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let requestCounter = 0;
let lastKandinskyRequest = 0;
const KANDINSKY_COOLDOWN = 10000; // 10 секунд между запросами

// ========== ПОЛУЧАЕМ СВЕЖИЙ ТОКЕН ==========
async function getFreshToken(requestId) {
    console.log(`\n[${requestId}] 🔑 Запрос токена...`);
    
    return new Promise((resolve, reject) => {
        const postData = 'scope=GIGACHAT_API_PERS';
        const rqUid = require('crypto').randomUUID();
        
        const options = {
            hostname: 'ngw.devices.sberbank.ru',
            port: 9443,
            path: '/api/v2/oauth',
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Authorization': `Basic ${AUTH_KEY}`,
                'RqUID': rqUid
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.access_token) {
                        console.log(`[${requestId}] ✅ Токен получен`);
                        setTimeout(() => resolve(json.access_token), 2000);
                    } else {
                        reject(new Error(`OAuth error`));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ========== KANDINSKY ==========
async function generateWithKandinsky(prompt, requestId) {
    console.log(`\n[${requestId}] 🎨 Kandinsky попытка...`);
    
    // Проверяем кулдаун
    const now = Date.now();
    const timeSinceLast = now - lastKandinskyRequest;
    if (timeSinceLast < KANDINSKY_COOLDOWN) {
        const waitTime = KANDINSKY_COOLDOWN - timeSinceLast;
        console.log(`[${requestId}] ⏳ Ожидание ${Math.ceil(waitTime/1000)} сек (cooldown)...`);
        await delay(waitTime);
    }
    lastKandinskyRequest = Date.now();
    
    try {
        const token = await getFreshToken(requestId);
        
        // Генерация
        const fileId = await new Promise((resolve, reject) => {
            const requestBody = JSON.stringify({
                model: 'GigaChat',
                messages: [{ role: 'user', content: prompt }]
            });

            const options = {
                hostname: 'gigachat.devices.sberbank.ru',
                path: '/api/v1/chat/completions',
                method: 'POST',
                rejectUnauthorized: false,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 429) {
                        reject(new Error('RATE_LIMIT'));
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.message?.content;
                        const imgMatch = content?.match(/<img src="([^"]+)"/);
                        if (imgMatch) {
                            resolve(imgMatch[1]);
                        } else {
                            reject(new Error('No file_id'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.write(requestBody);
            req.end();
        });
        
        await delay(3000);
        
        // Скачивание
        const imageBase64 = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'gigachat.devices.sberbank.ru',
                path: `/api/v1/files/${fileId}/content`,
                method: 'GET',
                rejectUnauthorized: false,
                headers: {
                    'Accept': 'application/jpg',
                    'Authorization': `Bearer ${token}`
                }
            };

            const req = https.request(options, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Download ${res.statusCode}`));
                    return;
                }
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    resolve(`data:image/jpeg;base64,${buffer.toString('base64')}`);
                });
            });
            req.on('error', reject);
            req.end();
        });
        
        return { image: imageBase64, provider: 'Kandinsky' };
        
    } catch (error) {
        if (error.message === 'RATE_LIMIT') {
            console.log(`[${requestId}] ⚠️ Лимит Kandinsky`);
        } else {
            console.log(`[${requestId}] ⚠️ Kandinsky ошибка: ${error.message}`);
        }
        return null;
    }
}

// ========== POLLINATIONS (альтернативный endpoint) ==========
async function generateWithPollinations(prompt, requestId) {
    console.log(`\n[${requestId}] 🎨 Pollinations...`);
    
    // Используем другой endpoint Pollinations без очереди
    const endpoints = [
        `https://pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&model=flux&nologo=true`,
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&model=flux&nologo=true`,
        `https://pollinations.ai/prompt/${encodeURIComponent(prompt.substring(0, 200))}?width=1024&height=1024`
    ];
    
    for (const url of endpoints) {
        try {
            console.log(`[${requestId}] 🌐 Пробуем: ${url.substring(0, 80)}...`);
            
            const imageData = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout')), 20000);
                
                https.get(url, (response) => {
                    clearTimeout(timeout);
                    
                    if (response.statusCode === 200 && response.headers['content-type']?.includes('image')) {
                        const chunks = [];
                        response.on('data', chunk => chunks.push(chunk));
                        response.on('end', () => {
                            const buffer = Buffer.concat(chunks);
                            if (buffer.length > 5000) {
                                resolve(buffer.toString('base64'));
                            } else {
                                reject(new Error('Image too small'));
                            }
                        });
                    } else {
                        reject(new Error(`HTTP ${response.statusCode}`));
                    }
                }).on('error', reject);
            });
            
            return { image: `data:image/jpeg;base64,${imageData}`, provider: 'Pollinations' };
            
        } catch (error) {
            console.log(`[${requestId}] ⚠️ Endpoint не работает: ${error.message}`);
        }
    }
    
    return null;
}

// ========== PLAYGROUND AI (альтернатива) ==========
async function generateWithPlayground(prompt, requestId) {
    console.log(`\n[${requestId}] 🎨 Playground AI...`);
    
    return new Promise((resolve) => {
        // Используем бесплатный API Playground AI
        const postData = JSON.stringify({
            prompt: prompt,
            width: 512,
            height: 512,
            num_samples: 1
        });
        
        const options = {
            hostname: 'api.playgroundai.com',
            path: '/v1/images/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer free-api-key-demo'
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.images && json.images[0]) {
                        resolve({ image: `data:image/png;base64,${json.images[0]}`, provider: 'Playground AI' });
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });
        
        req.on('error', () => resolve(null));
        req.write(postData);
        req.end();
    });
}

// ========== ГЕНЕРАЦИЯ СВГ ЗАГЛУШКИ ==========
function generateSVG(prompt, requestId) {
    console.log(`\n[${requestId}] 🎨 Создаем SVG с текстом промпта...`);
    
    const truncatedPrompt = prompt.length > 150 ? prompt.substring(0, 150) + '...' : prompt;
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
    <svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
            </linearGradient>
        </defs>
        <rect width="1024" height="1024" fill="url(#grad)"/>
        <text x="512" y="400" font-family="Arial, sans-serif" font-size="48" fill="white" text-anchor="middle" font-weight="bold">
            🎨 Генерация изображения
        </text>
        <text x="512" y="480" font-family="Arial, sans-serif" font-size="24" fill="#e0e0e0" text-anchor="middle">
            Сервисы временно недоступны
        </text>
        <text x="512" y="560" font-family="Arial, sans-serif" font-size="18" fill="#c0c0c0" text-anchor="middle">
            Ваш промпт:
        </text>
        <text x="512" y="600" font-family="Arial, sans-serif" font-size="16" fill="#d0d0d0" text-anchor="middle">
            "${truncatedPrompt}"
        </text>
    </svg>`;
    
    const base64 = Buffer.from(svg).toString('base64');
    return `data:image/svg+xml;base64,${base64}`;
}

// ========== ОСНОВНОЙ API С ПОСЛЕДОВАТЕЛЬНЫМИ ПОПЫТКАМИ ==========
app.post('/api/generate-image', async (req, res) => {
    requestCounter++;
    const requestId = `REQ-${requestCounter.toString().padStart(3, '0')}`;
    const startTotal = Date.now();
    
    console.log('\n' + '═'.repeat(60));
    console.log(`🚀 [${requestId}] ЗАПРОС (${new Date().toLocaleTimeString()})`);
    console.log(`📝 Промпт: ${req.body.prompt?.substring(0, 100)}...`);
    console.log('═'.repeat(60));
    
    try {
        const { prompt } = req.body;
        
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('Промпт не может быть пустым');
        }
        
        let result = null;
        
        // 1. Пробуем Kandinsky
        result = await generateWithKandinsky(prompt, requestId);
        if (result) {
            const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
            console.log(`\n[${requestId}] ✅ ${result.provider} за ${totalTime} сек`);
            return res.json({ success: true, image: result.image, provider: result.provider });
        }
        
        // 2. Пробуем Pollinations
        result = await generateWithPollinations(prompt, requestId);
        if (result) {
            const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
            console.log(`\n[${requestId}] ✅ ${result.provider} за ${totalTime} сек`);
            return res.json({ success: true, image: result.image, provider: result.provider });
        }
        
        // 3. Пробуем Playground AI
        result = await generateWithPlayground(prompt, requestId);
        if (result) {
            const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
            console.log(`\n[${requestId}] ✅ ${result.provider} за ${totalTime} сек`);
            return res.json({ success: true, image: result.image, provider: result.provider });
        }
        
        // 4. Последний шанс - SVG с текстом
        console.log(`\n[${requestId}] ⚠️ Все сервисы недоступны, создаем SVG...`);
        const svgImage = generateSVG(prompt, requestId);
        const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
        
        res.json({ 
            success: true, 
            image: svgImage, 
            provider: `SVG заглушка (${totalTime} сек)`,
            warning: 'Все сервисы временно недоступны, создано тестовое изображение'
        });
        
    } catch (error) {
        console.error(`\n[${requestId}] ❌ ОШИБКА:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
    
    console.log('═'.repeat(60) + '\n');
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log('═'.repeat(60));
    console.log(`🚀 Сервер: http://localhost:${PORT}`);
    console.log(`⏱️  Kandinsky кулдаун: ${KANDINSKY_COOLDOWN/1000} сек`);
    console.log(`🎨 Цепочка: Kandinsky → Pollinations → Playground AI → SVG`);
    console.log('═'.repeat(60));
});
