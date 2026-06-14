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

// ========== ВСЕГДА ПОЛУЧАЕМ СВЕЖИЙ ТОКЕН ==========
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
async function generateImage(prompt, token, requestId) {
    console.log(`\n[${requestId}] 🎨 Kandinsky: ${prompt.substring(0, 80)}...`);
    
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

// ========== ПОЛЛИНАЦИОНС - ИСПРАВЛЕННАЯ ВЕРСИЯ ==========
async function generatePollinations(prompt, requestId) {
    console.log(`\n[${requestId}] 🎨 Pollinations: ${prompt.substring(0, 80)}...`);
    
    return new Promise((resolve, reject) => {
        // Формируем URL с параметрами для получения качественного изображения
        const encodedPrompt = encodeURIComponent(prompt);
        const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=flux&nologo=true&seed=${Date.now()}`;
        
        console.log(`[${requestId}] 🌐 Запрос к Pollinations...`);
        
        const req = https.get(url, (response) => {
            // Проверяем Content-Type
            const contentType = response.headers['content-type'] || '';
            
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Обрабатываем редирект
                const location = response.headers.location;
                if (location) {
                    console.log(`[${requestId}] 🔄 Редирект на: ${location}`);
                    https.get(location, (redirectRes) => {
                        const chunks = [];
                        redirectRes.on('data', chunk => chunks.push(chunk));
                        redirectRes.on('end', () => {
                            const buffer = Buffer.concat(chunks);
                            if (buffer.length < 1000) {
                                reject(new Error('Изображение слишком маленькое'));
                                return;
                            }
                            console.log(`[${requestId}] ✅ Pollinations: ${(buffer.length/1024).toFixed(1)} KB`);
                            resolve(`data:image/jpeg;base64,${buffer.toString('base64')}`);
                        });
                    }).on('error', reject);
                    return;
                }
            }
            
            if (!contentType.includes('image/')) {
                // Если пришел JSON - пытаемся распарсить ошибку
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        console.error(`[${requestId}] Pollinations ошибка:`, json);
                        reject(new Error(`Pollinations API error: ${JSON.stringify(json)}`));
                    } catch (e) {
                        reject(new Error(`Pollinations вернул ${contentType}, не изображение`));
                    }
                });
                return;
            }
            
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                
                // Проверяем что изображение не пустое
                if (buffer.length < 1000) {
                    reject(new Error(`Изображение слишком маленькое (${buffer.length} bytes)`));
                    return;
                }
                
                console.log(`[${requestId}] ✅ Pollinations: ${(buffer.length/1024).toFixed(1)} KB`);
                resolve(`data:image/jpeg;base64,${buffer.toString('base64')}`);
            });
        });
        
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Таймаут Pollinations'));
        });
    });
}

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
        
        // Пробуем сначала Kandinsky
        try {
            const token = await getFreshToken(requestId);
            const fileId = await generateImage(prompt, token, requestId);
            await delay(3000);
            finalImage = await downloadImage(fileId, token, requestId);
            provider = 'Kandinsky (GigaChat)';
            
        } catch (kandinskyError) {
            console.log(`\n[${requestId}] ⚠️ Kandinsky ошибка: ${kandinskyError.message}`);
            console.log(`[${requestId}] 🔄 Переключаемся на Pollinations...`);
            
            // Пробуем Pollinations
            try {
                finalImage = await generatePollinations(prompt, requestId);
                provider = 'Pollinations.ai (Flux)';
            } catch (pollinationsError) {
                console.log(`[${requestId}] ❌ Pollinations тоже не работает: ${pollinationsError.message}`);
                throw new Error(`Оба сервиса недоступны: Kandinsky: ${kandinskyError.message}, Pollinations: ${pollinationsError.message}`);
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
    console.log(`🎨 Сервисы: Kandinsky (основной) → Pollinations (резерв)`);
    console.log('═'.repeat(60));
});
