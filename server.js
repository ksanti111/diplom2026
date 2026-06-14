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
    console.log(`\n[${requestId}] 🔑 Запрос СВЕЖЕГО токена (игнорируем кэш)...`);
    console.log(`[${requestId}] 📡 POST ngw.devices.sberbank.ru:9443/api/v2/oauth`);
    
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

        const reqStart = Date.now();
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const elapsed = Date.now() - reqStart;
                console.log(`[${requestId}] 📨 Ответ OAuth: ${res.statusCode} (${elapsed}ms)`);
                
                try {
                    const json = JSON.parse(data);
                    
                    if (json.access_token) {
                        console.log(`[${requestId}] ✅ СВЕЖИЙ токен получен!`);
                        console.log(`[${requestId}] ⏰ Истекает: ${new Date(json.expires_at).toLocaleTimeString()}`);
                        
                        // ВАЖНО: ждем 2 секунды перед использованием свежего токена
                        console.log(`[${requestId}] ⏳ Ожидание 2 сек для активации токена...`);
                        setTimeout(() => resolve(json.access_token), 2000);
                    } else {
                        console.error(`[${requestId}] ❌ Ошибка OAuth:`, json);
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

// ========== ГЕНЕРАЦИЯ ==========
async function generateImage(prompt, token, requestId) {
    console.log(`\n[${requestId}] 🎨 Отправка запроса на генерацию...`);
    console.log(`[${requestId}] 📝 Промпт (${prompt.length} символов): ${prompt.substring(0, 80)}...`);
    
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

        const reqStart = Date.now();
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const elapsed = ((Date.now() - reqStart) / 1000).toFixed(1);
                console.log(`[${requestId}] 📨 Ответ генерации: ${res.statusCode} (${elapsed} сек)`);
                
                if (res.statusCode !== 200) {
                    console.log(`[${requestId}] 📄 Тело ошибки:`, data.substring(0, 200));
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }
                
                try {
                    const json = JSON.parse(data);
                    
                    if (json.error) {
                        reject(new Error(`API Error: ${JSON.stringify(json.error)}`));
                        return;
                    }
                    
                    const content = json.choices?.[0]?.message?.content;
                    if (!content) {
                        reject(new Error('Нет content в ответе'));
                        return;
                    }

                    const imgMatch = content.match(/<img src="([^"]+)"/);
                    if (!imgMatch) {
                        console.log(`[${requestId}] 📄 Content:`, content.substring(0, 200));
                        reject(new Error('Не найден file_id'));
                        return;
                    }

                    const fileId = imgMatch[1];
                    console.log(`[${requestId}] ✅ file_id: ${fileId}`);
                    resolve(fileId);
                    
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(60000, () => {
            req.destroy();
            reject(new Error('Таймаут 60 сек'));
        });
        
        req.write(requestBody);
        req.end();
    });
}

// ========== СКАЧИВАНИЕ ==========
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

        const reqStart = Date.now();
        
        const req = https.request(options, (res) => {
            const elapsed = ((Date.now() - reqStart) / 1000).toFixed(1);
            console.log(`[${requestId}] 📨 Ответ скачивания: ${res.statusCode} (${elapsed} сек)`);
            
            if (res.statusCode !== 200) {
                reject(new Error(`Ошибка скачивания ${res.statusCode}`));
                return;
            }
            
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                console.log(`[${requestId}] ✅ Скачано ${(buffer.length/1024).toFixed(1)} KB`);
                const base64 = buffer.toString('base64');
                resolve(`data:image/jpeg;base64,${base64}`);
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => reject(new Error('Таймаут скачивания')));
        req.end();
    });
}

// ========== РЕЗЕРВ ==========
async function fallbackImage(prompt, requestId) {
    console.log(`\n[${requestId}] 🔄 Резервный генератор Pollinations.ai...`);
    
    return new Promise((resolve, reject) => {
        const encodedPrompt = encodeURIComponent(prompt.substring(0, 200));
        const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=800&height=600&model=flux&nologo=true`;
        
        https.get(url, (response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                console.log(`[${requestId}] ✅ Резерв: ${(buffer.length/1024).toFixed(1)} KB`);
                const base64 = buffer.toString('base64');
                resolve(`data:image/jpeg;base64,${base64}`);
            });
        }).on('error', reject);
    });
}

// ========== ОСНОВНОЙ API ==========
app.post('/api/generate-image', async (req, res) => {
    requestCounter++;
    const requestId = `REQ-${requestCounter.toString().padStart(3, '0')}`;
    const startTotal = Date.now();
    
    console.log('\n' + '═'.repeat(60));
    console.log(`🚀 [${requestId}] НАЧАЛО ЗАПРОСА (${new Date().toLocaleTimeString()})`);
    console.log('═'.repeat(60));
    
    try {
        const { prompt } = req.body;
        
        let finalImage;
        let provider = 'Неизвестно';
        
        try {
            // 🔥 КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: ВСЕГДА получаем СВЕЖИЙ токен перед генерацией!
            const token = await getFreshToken(requestId);
            
            // Генерация
            const fileId = await generateImage(prompt, token, requestId);
            
            // Задержка перед скачиванием
            console.log(`\n[${requestId}] ⏳ Задержка 3 сек перед скачиванием...`);
            await delay(3000);
            
            // Скачивание с ТЕМ ЖЕ токеном
            finalImage = await downloadImage(fileId, token, requestId);
            provider = 'GigaChat + Kandinsky';
            
        } catch (gigaError) {
            console.log(`\n[${requestId}] ⚠️ GigaChat ошибка: ${gigaError.message}`);
            console.log(`[${requestId}] 🔄 Переключаемся на резерв...`);
            
            finalImage = await fallbackImage(prompt, requestId);
            provider = 'Резервный (Pollinations.ai)';
        }
        
        const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
        console.log(`\n[${requestId}] ✅ ЗАВЕРШЕНО за ${totalTime} сек (${provider})`);
        console.log('═'.repeat(60) + '\n');
        
        res.json({ success: true, image: finalImage, provider });
        
    } catch (error) {
        console.error(`\n[${requestId}] ❌ КРИТИЧЕСКАЯ ОШИБКА:`, error.message);
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
    console.log(`💡 СВЕЖИЙ ТОКЕН для КАЖДОГО запроса`);
    console.log('═'.repeat(60));
});