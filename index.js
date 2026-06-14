const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');

const app = express();
const PORT = 3001;

const AUTH_KEY = 'MDE5ZDZjNzQtNTVkMC03NDFmLTgxMmUtNWRhZWNiZjIwNzY1OjNiYzQwMjc3LWNiYjQtNGI2NS1hNzY4LTI3ZDAwMDM1MzZlMQ==';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let requestCounter = 0;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000; // 5 секунд между запросами к Kandinsky

// ========== ПОЛУЧАЕМ СВЕЖИЙ ТОКЕН ==========
async function getFreshToken(requestId) {
    console.log(`\n[${requestId}] 🔑 Запрос СВЕЖЕГО токена...`);
    
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
                        reject(new Error(`OAuth error: ${JSON.stringify(json)}`));
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

// ========== ГЕНЕРАЦИЯ ЧЕРЕЗ KANDINSKY ==========
async function generateImage(prompt, token, requestId, retryCount = 0) {
    console.log(`\n[${requestId}] 🎨 Kandinsky попытка ${retryCount + 1}: ${prompt.substring(0, 80)}...`);
    
    // Проверяем интервал между запросами
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
        console.log(`[${requestId}] ⏳ Ожидание ${waitTime/1000} сек (rate limit)...`);
        await delay(waitTime);
    }
    lastRequestTime = Date.now();
    
    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify({
            model: 'GigaChat',
            messages: [{ role: 'user', content: prompt }],
            function_call: 'auto'
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
                    if (retryCount < 3) {
                        console.log(`[${requestId}] ⚠️ 429 ошибка, повтор через ${(retryCount + 1) * 3} сек...`);
                        setTimeout(() => {
                            generateImage(prompt, token, requestId, retryCount + 1)
                                .then(resolve)
                                .catch(reject);
                        }, (retryCount + 1) * 3000);
                    } else {
                        reject(new Error('Превышен лимит запросов к Kandinsky'));
                    }
                    return;
                }
                
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                
                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.message?.content;
                    if (!content) {
                        reject(new Error('Нет content'));
                        return;
                    }

                    const imgMatch = content.match(/<img src="([^"]+)"/);
                    if (!imgMatch) {
                        reject(new Error('Не найден file_id'));
                        return;
                    }

                    resolve(imgMatch[1]);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(60000, () => reject(new Error('Таймаут')));
        req.write(requestBody);
        req.end();
    });
}

// ========== СКАЧИВАНИЕ ИЗ KANDINSKY ==========
async function downloadImage(fileId, token, requestId) {
    console.log(`\n[${requestId}] 📥 Скачивание ${fileId}...`);
    
    return new Promise((resolve, reject) => {
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
                reject(new Error(`Ошибка ${res.statusCode}`));
                return;
            }
            
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                console.log(`[${requestId}] ✅ Скачано ${(buffer.length/1024).toFixed(1)} KB`);
                resolve(`data:image/jpeg;base64,${buffer.toString('base64')}`);
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => reject(new Error('Таймаут')));
        req.end();
    });
}

// ========== ALTERNATIVE FREE IMAGE API (NO RATE LIMIT) ==========
async function generateAlternativeImage(prompt, requestId) {
    console.log(`\n[${requestId}] 🎨 Используем резервный API...`);
    
    // Используем бесплатный API с высокими лимитами
    const services = [
        {
            name: 'OpenArt API',
            url: `https://api.openart.ai/api/v1/generate?prompt=${encodeURIComponent(prompt)}`,
            method: 'GET'
        },
        {
            name: 'Lexica API',
            url: `https://lexica.art/api/v1/search?q=${encodeURIComponent(prompt)}`,
            method: 'GET'
        }
    ];
    
    for (const service of services) {
        try {
            console.log(`[${requestId}] 🌐 Пробуем ${service.name}...`);
            
            const result = await new Promise((resolve, reject) => {
                const req = https.get(service.url, (response) => {
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            if (json.images && json.images[0] && json.images[0].url) {
                                resolve(json.images[0].url);
                            } else if (json.data && json.data[0] && json.data[0].url) {
                                resolve(json.data[0].url);
                            } else {
                                reject(new Error('Нет URL изображения'));
                            }
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(10000, () => reject(new Error('Таймаут')));
            });
            
            // Скачиваем изображение по полученному URL
            const imageData = await new Promise((resolve, reject) => {
                https.get(result, (imgRes) => {
                    const chunks = [];
                    imgRes.on('data', chunk => chunks.push(chunk));
                    imgRes.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        if (buffer.length < 1000) {
                            reject(new Error('Изображение слишком маленькое'));
                            return;
                        }
                        resolve(`data:image/jpeg;base64,${buffer.toString('base64')}`);
                    });
                }).on('error', reject);
            });
            
            console.log(`[${requestId}] ✅ ${service.name} успешно`);
            return imageData;
            
        } catch (error) {
            console.log(`[${requestId}] ⚠️ ${service.name} ошибка: ${error.message}`);
        }
    }
    
    throw new Error('Все резервные API недоступны');
}

// ========== POLLINATIONS С ОЧЕРЕДЬЮ ==========
class PollinationsQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.lastRequestTime = 0;
        this.minDelay = 3000; // 3 секунды между запросами
    }
    
    async add(prompt, requestId) {
        return new Promise((resolve, reject) => {
            this.queue.push({ prompt, requestId, resolve, reject });
            this.process();
        });
    }
    
    async process() {
        if (this.isProcessing || this.queue.length === 0) return;
        
        this.isProcessing = true;
        const task = this.queue.shift();
        
        try {
            // Ждем минимальную задержку
            const now = Date.now();
            const timeSinceLast = now - this.lastRequestTime;
            if (timeSinceLast < this.minDelay) {
                await delay(this.minDelay - timeSinceLast);
            }
            
            const result = await this.makeRequest(task.prompt, task.requestId);
            this.lastRequestTime = Date.now();
            task.resolve(result);
        } catch (error) {
            task.reject(error);
        }
        
        this.isProcessing = false;
        this.process();
    }
    
    async makeRequest(prompt, requestId) {
        console.log(`\n[${requestId}] 🎨 Pollinations (очередь): ${prompt.substring(0, 80)}...`);
        
        return new Promise((resolve, reject) => {
            const encodedPrompt = encodeURIComponent(prompt);
            // Используем другой endpoint Pollinations
            const url = `https://pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=flux&nologo=true&seed=${Date.now()}`;
            
            const req = https.get(url, (response) => {
                if (response.statusCode === 200) {
                    const chunks = [];
                    response.on('data', chunk => chunks.push(chunk));
                    response.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        if (buffer.length < 1000) {
                            reject(new Error('Изображение слишком маленькое'));
                            return;
                        }
                        console.log(`[${requestId}] ✅ Pollinations: ${(buffer.length/1024).toFixed(1)} KB`);
                        resolve(`data:image/jpeg;base64,${buffer.toString('base64')}`);
                    });
                } else {
                    reject(new Error(`HTTP ${response.statusCode}`));
                }
            });
            
            req.on('error', reject);
            req.setTimeout(30000, () => reject(new Error('Таймаут')));
        });
    }
}

const pollinationsQueue = new PollinationsQueue();

// ========== ОСНОВНОЙ API ==========
app.post('/api/generate-image', async (req, res) => {
    requestCounter++;
    const requestId = `REQ-${requestCounter.toString().padStart(3, '0')}`;
    const startTotal = Date.now();
    
    console.log('\n' + '═'.repeat(60));
    console.log(`🚀 [${requestId}] НАЧАЛО (${new Date().toLocaleTimeString()})`);
    console.log('═'.repeat(60));
    
    try {
        const { prompt } = req.body;
        
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('Промпт не может быть пустым');
        }
        
        let finalImage;
        let provider = 'Неизвестно';
        
        // Пробуем Kandinsky с повторами
        try {
            const token = await getFreshToken(requestId);
            const fileId = await generateImage(prompt, token, requestId);
            await delay(3000);
            finalImage = await downloadImage(fileId, token, requestId);
            provider = 'Kandinsky (GigaChat)';
            
        } catch (kandinskyError) {
            console.log(`\n[${requestId}] ⚠️ Kandinsky ошибка: ${kandinskyError.message}`);
            console.log(`[${requestId}] 🔄 Переключаемся на Pollinations...`);
            
            // Пробуем Pollinations с очередью
            try {
                finalImage = await pollinationsQueue.add(prompt, requestId);
                provider = 'Pollinations.ai (с очередью)';
            } catch (pollinationsError) {
                console.log(`[${requestId}] ⚠️ Pollinations ошибка: ${pollinationsError.message}`);
                console.log(`[${requestId}] 🔄 Переключаемся на альтернативный API...`);
                
                // Последняя попытка - альтернативный API
                finalImage = await generateAlternativeImage(prompt, requestId);
                provider = 'Резервный API';
            }
        }
        
        const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
        console.log(`\n[${requestId}] ✅ ЗАВЕРШЕНО за ${totalTime} сек (${provider})`);
        console.log('═'.repeat(60) + '\n');
        
        res.json({ success: true, image: finalImage, provider });
        
    } catch (error) {
        console.error(`\n[${requestId}] ❌ ОШИБКА:`, error.message);
        console.log('═'.repeat(60) + '\n');
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log('═'.repeat(60));
    console.log(`🚀 Сервер: http://localhost:${PORT}`);
    console.log(`⏱️  Интервал между запросами: ${MIN_REQUEST_INTERVAL/1000} сек`);
    console.log(`🎨 1. Kandinsky (с повторами при 429)`);
    console.log(`🎨 2. Pollinations (с очередью)`);
    console.log(`🎨 3. Резервный API`);
    console.log('═'.repeat(60));
});
