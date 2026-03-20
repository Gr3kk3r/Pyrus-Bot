import hashlib
import hmac
import json
import os
import logging
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

# Настройка логирования для Railway
logging.basicConfig(level=logging.INFO)

# Секретный ключ из настроек бота в Pyrus
PYRUS_SECRET_KEY = os.environ.get('PYRUS_SECRET_KEY', 'your_secret_key_here')

def verify_signature(data, signature):
    """Проверяет подпись запроса от Pyrus"""
    if not signature:
        return False
    computed = hmac.new(
        PYRUS_SECRET_KEY.encode('utf-8'),
        data,
        hashlib.sha1
    ).hexdigest()
    return hmac.compare_digest(computed, signature)

@app.route('/pulse', methods=['GET'])
def pulse():
    """Heartbeat endpoint — проверка доступности сервиса"""
    return jsonify({"status": "ok"}), 200

@app.route('/authorize', methods=['POST'])
def authorize():
    """
    Авторизация бота.
    Pyrus вызывает этот эндпоинт при подключении расширения к форме.
    """
    # Проверяем подпись
    signature = request.headers.get('X-Pyrus-Sig')
    if not verify_signature(request.data, signature):
        logging.warning("Invalid signature in /authorize")
        return jsonify({"error": "Invalid signature"}), 403
    
    payload = request.get_json()
    logging.info(f"Authorization request received: {payload}")
    
    # В on-premise версии обычно достаточно вернуть account_id и account_name
    # Если нужна OAuth2, здесь будет дополнительная логика [citation:1]
    response_data = {
        "account_id": "railway_bot_1",
        "account_name": "Bot for task re-saving"
    }
    
    return jsonify(response_data), 200

@app.route('/event', methods=['POST'])
def event():
    """
    Основной обработчик событий.
    Вызывается при создании задачи, изменении полей, смене ответственного и т.д. [citation:1]
    """
    # Проверяем подпись
    signature = request.headers.get('X-Pyrus-Sig')
    if not verify_signature(request.data, signature):
        logging.warning("Invalid signature in /event")
        return jsonify({"error": "Invalid signature"}), 403
    
    payload = request.get_json()
    task_id = payload.get('task_id')
    access_token = payload.get('access_token')
    
    logging.info(f"Event received for task {task_id}")
    
    if not task_id:
        return jsonify({"status": "ok"}), 200
    
    # Для on-premise API endpoint может отличаться!
    # Уточни у администратора внутренний URL Pyrus API
    base_url = os.environ.get('PYRUS_API_URL', 'https://api.pyrus.com')
    
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    
    # Получаем текущую задачу
    get_url = f"{base_url}/v4/tasks/{task_id}"
    get_response = requests.get(get_url, headers=headers)
    
    if get_response.status_code != 200:
        logging.error(f"Failed to fetch task {task_id}: {get_response.text}")
        return jsonify({"status": "error"}), 500
    
    task_data = get_response.json().get('task', {})
    
    # Формируем запрос на обновление (пересохранение)
    # Отправляем минимальный набор полей для обновления
    patch_payload = {}
    
    if 'text' in task_data:
        patch_payload['text'] = task_data['text']
    
    if 'responsible' in task_data and task_data['responsible']:
        patch_payload['responsible'] = task_data['responsible']['id']
    
    # Если задача формы, может потребоваться поле form_values
    # Для простого пересохранения достаточно пустого тела?
    # Но лучше отправить текущий текст, чтобы обновление точно произошло
    
    if patch_payload:
        patch_url = f"{base_url}/v4/tasks/{task_id}"
        patch_response = requests.patch(patch_url, json=patch_payload, headers=headers)
        
        if patch_response.status_code in [200, 204]:
            logging.info(f"Task {task_id} successfully re-saved")
        else:
            logging.error(f"Failed to re-save task {task_id}: {patch_response.text}")
    else:
        logging.info(f"No fields to update for task {task_id}")
    
    return jsonify({"status": "ok"}), 200

@app.route('/toggle', methods=['POST'])
def toggle():
    """
    Управление уведомлениями (опционально).
    Вызывается при включении/отключении расширения [citation:1]
    """
    signature = request.headers.get('X-Pyrus-Sig')
    if not verify_signature(request.data, signature):
        return jsonify({"error": "Invalid signature"}), 403
    
    payload = request.get_json()
    enabled = payload.get('enabled', False)
    deleted = payload.get('deleted', False)
    
    logging.info(f"Toggle: enabled={enabled}, deleted={deleted}")
    
    # Здесь можно добавить логику активации/деактивации
    # Например, сохранять состояние в Redis или БД
    
    return jsonify({}), 200

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)