const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

// ============================================
// ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ОШИБОК
// ============================================
process.on('uncaughtException', (error) => {
    console.error('💥 UNCAUGHT EXCEPTION:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION:', reason);
    console.error('Promise:', promise);
    process.exit(1);
});

const app = express();
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const config = {
    secretKey: process.env.PYRUS_BOT_SECRET,
    targetFormId: process.env.TARGET_FORM_ID || 91, // Важно: 91, а не 84!
    fieldNames: {
        sourceField: process.env.SOURCE_FIELD || 'personText',
        targetField: process.env.TARGET_FIELD || 'personForm',
        lastName: process.env.LAST_NAME_FIELD || 'Фамилия',
        firstName: process.env.FIRST_NAME_FIELD || 'Имя',
        middleName: process.env.MIDDLE_NAME_FIELD || 'Отчество'
    },
    security: {
        maxNameParts: 5,
        minNameParts: 3,
        tokenExpiryBuffer: 60,
        maxRetries: 3
    }
};

// ============================================
// ВАЛИДАЦИЯ
// ============================================
if (!config.secretKey) {
    console.error('❌ CRITICAL: PYRUS_BOT_SECRET not set');
    process.exit(1);
}

// ============================================
// ПРОВЕРКА ПОДПИСИ
// ============================================
function verifySignature(rawBody, signature, secret) {
    if (!signature || !rawBody) {
        console.warn('⚠️ Missing signature or body');
        return false;
    }

    try {
        const hmac = crypto.createHmac('sha1', secret);
        hmac.update(rawBody);
        const digest = hmac.digest('hex').toLowerCase();
        
        const signatureBuffer = Buffer.from(signature.toLowerCase());
        const digestBuffer = Buffer.from(digest);
        
        if (signatureBuffer.length !== digestBuffer.length) {
            return false;
        }
        
        return crypto.timingSafeEqual(signatureBuffer, digestBuffer);
    } catch (error) {
        console.error('❌ Signature verification error:', error.message);
        return false;
    }
}

// ============================================
// ПАРСИНГ ФИО
// ============================================
function parseFullName(fullName) {
    if (!fullName || typeof fullName !== 'string') {
        return {
            success: false,
            error: 'Empty or invalid name'
        };
    }

    const cleanName = fullName.trim().replace(/\s+/g, ' ');
    const parts = cleanName.split(' ').filter(p => p.length > 0);

    if (parts.length < config.security.minNameParts) {
        return {
            success: false,
            error: `Expected at least ${config.security.minNameParts} name parts, got ${parts.length}`
        };
    }

    if (parts.length > config.security.maxNameParts) {
        return {
            success: false,
            error: `Too many name parts (max ${config.security.maxNameParts})`
        };
    }

    return {
        success: true,
        lastName: parts[0],
        firstName: parts[1],
        middleName: parts.slice(2).join(' '),
        original: cleanName
    };
}

// ============================================
// ПОИСК СОТРУДНИКА
// ============================================
async function findEmployee(nameData, accessToken, retryCount = 0) {
    try {
        console.log(`🔍 Searching for: ${nameData.lastName} ${nameData.firstName} ${nameData.middleName}`);

        const response = await fetch(`https://api.pyrus.com/v4/forms/${config.targetFormId}/registry`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filters: [
                    { type: 'equals', field: config.fieldNames.lastName, value: nameData.lastName },
                    { type: 'equals', field: config.fieldNames.firstName, value: nameData.firstName },
                    { type: 'equals', field: config.fieldNames.middleName, value: nameData.middleName }
                ]
            })
        });

        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('Unauthorized - check bot permissions');
            }
            if (response.status === 429 && retryCount < config.security.maxRetries) {
                const waitTime = Math.pow(2, retryCount) * 1000;
                console.log(`⏳ Rate limited, retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return findEmployee(nameData, accessToken, retryCount + 1);
            }
            throw new Error(`Registry search failed: ${response.status}`);
        }

        const data = await response.json();
        console.log(`📊 Found ${data.tasks?.length || 0} tasks`);

        return {
            success: true,
            tasks: data.tasks || [],
            count: data.tasks?.length || 0
        };

    } catch (error) {
        if (retryCount < config.security.maxRetries) {
            console.log(`🔄 Retry ${retryCount + 1}/${config.security.maxRetries} after error:`, error.message);
            const waitTime = Math.pow(2, retryCount) * 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return findEmployee(nameData, accessToken, retryCount + 1);
        }
        
        return {
            success: false,
            error: error.message
        };
    }
}

// ============================================
// ОБНОВЛЕНИЕ ПОЛЯ
// ============================================
async function updateTaskField(taskId, employeeId, accessToken) {
    try {
        const commentResponse = await fetch(`https://api.pyrus.com/v4/tasks/${taskId}/comments`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: `✅ Автоматически найден сотрудник (бот)`,
                field_updates: [
                    {
                        field: config.fieldNames.targetField,
                        value: employeeId
                    }
                ]
            })
        });

        if (!commentResponse.ok) {
            throw new Error(`Failed to update field: ${commentResponse.status}`);
        }

        console.log(`✅ Field ${config.fieldNames.targetField} updated with task ${employeeId}`);

        const stepResponse = await fetch(`https://api.pyrus.com/v4/tasks/${taskId}/steps/complete`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!stepResponse.ok) {
            console.warn(`⚠️ Failed to complete step: ${stepResponse.status}`);
            return {
                success: true,
                warning: 'Field updated but step completion failed'
            };
        }

        console.log(`✅ Step completed for task ${taskId}`);
        return { success: true };

    } catch (error) {
        console.error('❌ Update failed:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// ============================================
// WEBHOOK ОБРАБОТЧИК
// ============================================
app.post('/webhook', async (req, res) => {
    const startTime = Date.now();
    const requestId = crypto.randomBytes(4).toString('hex');

    console.log(`\n=== [${requestId}] NEW REQUEST ===`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log('Task ID:', req.body.task?.id);

    try {
        const signature = req.headers['x-pyrus-sig'];
        if (!verifySignature(req.rawBody, signature, config.secretKey)) {
            console.error(`❌ [${requestId}] Invalid signature`);
            return res.status(403).json({ 
                error: 'Invalid signature',
                code: 'AUTH_FAILED'
            });
        }
        console.log(`✅ [${requestId}] Signature verified`);

        const { task, access_token } = req.body;
        
        if (!task || !task.id) {
            console.error(`❌ [${requestId}] Invalid task data`);
            return res.status(400).json({ 
                error: 'Invalid task data',
                code: 'INVALID_TASK'
            });
        }

        console.log(`📋 [${requestId}] Task ID: ${task.id}`);

        const personField = task.fields?.find(f => 
            f.name === config.fieldNames.sourceField || 
            f.code === config.fieldNames.sourceField
        );

        if (!personField?.value) {
            console.log(`ℹ️ [${requestId}] Source field empty`);
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/steps/complete`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return res.json({ 
                text: 'Поле personText не заполнено, этап завершен',
                code: 'NO_ACTION'
            });
        }

        const nameData = parseFullName(personField.value);
        if (!nameData.success) {
            console.log(`⚠️ [${requestId}] Name parsing failed: ${nameData.error}`);
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/comments`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: `❌ Ошибка: ${nameData.error}`
                })
            });
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/steps/complete`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return res.json({ 
                text: `Ошибка формата ФИО: ${nameData.error}`,
                code: 'INVALID_NAME_FORMAT'
            });
        }

        const searchResult = await findEmployee(nameData, access_token);

        if (!searchResult.success) {
            console.error(`❌ [${requestId}] Search failed:`, searchResult.error);
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/comments`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: `❌ Ошибка поиска: ${searchResult.error}`
                })
            });
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/steps/complete`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return res.status(500).json({ 
                text: `Ошибка поиска: ${searchResult.error}`,
                code: 'SEARCH_FAILED'
            });
        }

        if (searchResult.count === 0) {
            console.log(`ℹ️ [${requestId}] No employees found`);
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/comments`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: `❌ Сотрудник "${nameData.original}" не найден в форме ${config.targetFormId}`
                })
            });
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/steps/complete`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return res.json({ 
                text: `Сотрудник не найден`,
                code: 'NOT_FOUND'
            });
        }

        if (searchResult.count > 1) {
            console.log(`⚠️ [${requestId}] Multiple employees found:`, 
                searchResult.tasks.map(t => t.id));
            
            const ids = searchResult.tasks.map(t => t.id).join(', ');
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/comments`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: `⚠️ Найдено несколько сотрудников (${searchResult.count}): ${ids}. Требуется ручная проверка.`
                })
            });
            
            await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/steps/complete`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return res.json({ 
                text: `Найдено несколько сотрудников (${searchResult.count})`,
                code: 'MULTIPLE_FOUND'
            });
        }

        const employee = searchResult.tasks[0];
        console.log(`✅ [${requestId}] Found exactly one employee: ${employee.id}`);

        const updateResult = await updateTaskField(task.id, employee.id, access_token);

        const processingTime = Date.now() - startTime;
        console.log(`✅ [${requestId}] Successfully processed in ${processingTime}ms`);

        return res.json({ 
            text: `✅ Найден сотрудник: задача №${employee.id}`,
            code: 'SUCCESS',
            employeeId: employee.id,
            processingTime
        });

    } catch (error) {
        console.error(`❌ [${requestId}] Unhandled error:`, error);
        console.error('Stack:', error.stack);
        
        try {
            const { task, access_token } = req.body;
            if (task?.id && access_token) {
                await fetch(`https://api.pyrus.com/v4/tasks/${task.id}/steps/complete`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${access_token}`,
                        'Content-Type': 'application/json'
                    }
                });
            }
        } catch (stepError) {
            console.error('❌ Failed to complete step after error:', stepError);
        }

        return res.status(500).json({ 
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================
// HEALTH CHECKS
// ============================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '2.0.0-enterprise'
    });
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'pyrus-bot',
        message: 'Бот для поиска сотрудников работает',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log('\n=================================');
    console.log('🚀 ENTERPRISE BOT STARTED');
    console.log('=================================');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🎯 Target form: ${config.targetFormId}`);
    console.log(`🔑 Secret key: ${config.secretKey ? '✅ configured' : '❌ MISSING'}`);
    console.log(`📊 Source field: ${config.fieldNames.sourceField}`);
    console.log(`📋 Target field: ${config.fieldNames.targetField}`);
    console.log('=================================\n');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});