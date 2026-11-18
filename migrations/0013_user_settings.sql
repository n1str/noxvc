-- Настройки пользователя, общие для всех его устройств: горячие клавиши, голос, тема (ключи — whitelist в API).
ALTER TABLE users ADD COLUMN settings JSONB NOT NULL DEFAULT '{}';
