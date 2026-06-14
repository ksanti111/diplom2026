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

// ========== УЛУЧШЕННЫЙ РЕЗЕРВНЫЙ ГЕНЕРАТОР ==========
async function fallbackImage(prompt, requestId) {
    console.log(`\n[${requestId}] 🔄 Резервный генератор - пробуем несколько сервисов...`);
    
    // Список резервных сервисов в порядке приоритета
    const services = [
        {
            name: 'Pollinations (прямой URL)',
            url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now()}`,
            checkSize: true
        },
        {
            name: 'DummyJSON (тестовая заглушка)',
            url: 'https://picsum.photos/1024/1024',
            checkSize: false
        },
        {
            name: 'Placeholder Cat',
            url: 'https://cataas.com/cat/says/' + encodeURIComponent(prompt.substring(0, 30)),
            checkSize: false
        }
    ];
    
    for (const service of services) {
        try {
            console.log(`[${requestId}] 🎨 Пробуем ${service.name}...`);
            
            const imageData = await new Promise((resolve, reject) => {
                const protocol = service.url.startsWith('https') ? https : http;
                const timeout = setTimeout(() => reject(new Error('Таймаут')), 15000);
                
                protocol.get(service.url, (response) => {
                    clearTimeout(timeout);
                    
                    // Проверяем Content-Type
                    const contentType = response.headers['content-type'] || '';
                    if (!contentType.includes('image/')) {
                        reject(new Error(`Не image тип: ${contentType}`));
                        return;
                    }
                    
                    const chunks = [];
                    response.on('data', chunk => chunks.push(chunk));
                    response.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        
                        // Проверяем размер (игнорируем маленькие файлы - возможные ошибки)
                        if (service.checkSize && buffer.length < 5000) {
                            reject(new Error(`Слишком маленький файл: ${buffer.length} bytes`));
                            return;
                        }
                        
                        console.log(`[${requestId}] ✅ ${service.name}: ${(buffer.length/1024).toFixed(1)} KB`);
                        resolve(buffer.toString('base64'));
                    });
                    response.on('error', reject);
                }).on('error', reject);
            });
            
            return `data:image/jpeg;base64,${imageData}`;
            
        } catch (error) {
            console.log(`[${requestId}] ⚠️ ${service.name} не работает: ${error.message}`);
            continue;
        }
    }
    
    // Если всё совсем плохо - генерируем SVG с текстом ошибки
    console.log(`[${requestId}] 🎨 Создаём SVG заглушку с текстом промпта...`);
    const svgImage = generateSvgFallback(prompt);
    return svgImage;
}

// Генерация SVG заглушки с текстом
function generateSvgFallback(prompt) {
    const truncatedPrompt = prompt.length > 100 ? prompt.substring(0, 100) + '...' : prompt;
    const svg = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
        <rect width="800" height="600" fill="#f0f0f0"/>
        <rect x="100" y="100" width="600" height="400" fill="#e0e0e0" stroke="#999" stroke-width="2"/>
        <text x="400" y="200" font-family="Arial" font-size="24" fill="#333" text-anchor="middle" font-weight="bold">
            🎨 Генерация временно недоступна
        </text>
        <text x="400" y="250" font-family="Arial" font-size="18" fill="#666" text-anchor="middle">
            Используются резервные источники
        </text>
        <text x="400" y="320" font-family="Arial" font-size="14" fill="#888" text-anchor="middle">
            Ваш промпт:
        </text>
        <text x="400" y="350" font-family="Arial" font-size="13" fill="#666" text-anchor="middle">
            "${truncatedPrompt}"
        </text>
        <text x="400" y="450" font-family="Arial" font-size="12" fill="#aaa" text-anchor="middle">
            Попробуйте позже или измените промпт
        </text>
    </svg>`;
    
    const base64 = Buffer.from(svg).toString('base64');
    return `data:image/svg+xml;base64,${base64}`;
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
        
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('Промпт не может быть пустым');
        }
        
        let finalImage;
        let provider = 'Неизвестно';
        
        try {
            // 🔥 Получаем СВЕЖИЙ токен перед генерацией!
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
            provider = 'Резервный (комбинированный)';
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
