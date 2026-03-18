const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Конфигурация
const SECRET_KEY = process.env.PYRUS_BOT_SECRET; // Позже добавим в Railway
const TARGET_FORM_ID = 6; // ID формы с сотрудниками

// Проверка подписи Pyrus
function verifySignature(body, signature, secret) {
    if (!signature) return false;
    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(JSON.stringify(body));
    const digest = hmac.digest('hex').toLowerCase();
    return crypto.timingSafeEqual(
        Buffer.from(digest),
        Buffer.from(signature.toLowerCase())
    );
}

// Поиск сотрудника в форме 6
async function findEmployee(fullName, accessToken) {
    const nameParts = fullName.split(' ').filter(p => p);
    if (nameParts.length < 3) return null;

    const [lastName, firstName, ...middleParts] = nameParts;
    const middleName = middleParts.join(' ');

    // Запрос к API Pyrus для поиска
    const response = await fetch(`https://api.pyrus.com/v4/forms/${TARGET_FORM_ID}/registry`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            filters: [
                { type: 'equals', field: 'Фамилия', value: lastName },
                { type: 'equals', field: 'Имя', value: firstName },
                { type: 'equals', field: 'Отчество', value: middleName }
            ]
        })
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.tasks?.[0] || null;
}

// Основной обработчик
app.post('/webhook', async (req, res) => {
    try {
        // Проверка подписи
        const signature = req.headers['x-pyrus-sig'];
        if (!verifySignature(req.body, signature, SECRET_KEY)) {
            return res.status(403).json({ error: 'Invalid signature' });
        }

        const { task, access_token } = req.body;

        // Ищем поле personText
        const personField = task.fields?.find(f => 
            f.name === 'personText' || f.code === 'personText'
        );

        if (!personField?.value) {
            return res.json({ text: 'Поле personText не заполнено' });
        }

        // Ищем сотрудника
        const employee = await findEmployee(personField.value, access_token);

        if (employee) {
            // Обновляем поле personForm
            const updateResponse = await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/comments`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: 'Автоматически найден сотрудник',
                    field_updates: [
                        {
                            field: 'personForm',
                            value: employee.id
                        }
                    ]
                })
            });

            return res.json({ 
                text: `✅ Найден сотрудник: задача №${employee.id}` 
            });
        } else {
            return res.json({ 
                text: `❌ Сотрудник "${personField.value}" не найден` 
            });
        }

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ 
            text: `Ошибка: ${error.message}` 
        });
    }
});

// Health check для Railway
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bot running on port ${PORT}`);
});