/**
 * Скрипт для создания установщика zeithub.otto
 * 
 * Этот скрипт автоматически генерирует установщик для Windows,
 * используя существующие инструменты проекта.
 */

// Импортируем необходимые модули
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Запуск создания установщика zeithub.otto...');

try {
  // Проверяем наличие node_modules
  if (!fs.existsSync('./node_modules')) {
    console.log('📦 Установка зависимостей...');
    execSync('npm install', { stdio: 'inherit' });
  }

  // Сначала собираем все приложения (web и desktop)
  console.log('🏗️  Сборка проекта...');
  execSync('npm run build', { stdio: 'inherit' });

  // Генерируем ресурсы для установщика
  console.log('🎨 Генерация ресурсов установщика...');
  execSync('npm run installer-assets -w @otto/desktop', { stdio: 'inherit' });

  // Создаем установщик для Windows (NSIS)
  console.log('📦 Создание установщика для Windows...');
  execSync('npm run dist:win', { stdio: 'inherit' });
  
  console.log('✅ Установщик успешно создан!');
  
  // Показываем путь к файлу установки
  const releaseDir = './apps/desktop/release';
  if (fs.existsSync(releaseDir)) {
    const files = fs.readdirSync(releaseDir);
    const setupFile = files.find(f => f.endsWith('.exe'));
    if (setupFile) {
      console.log(`📍 Установщик находится в: ${path.join(releaseDir, setupFile)}`);
      
      // Пытаемся скопировать файл на рабочий стол
      try {
        const desktopPath = path.join(require('os').homedir(), 'Desktop');
        const destination = path.join(desktopPath, setupFile);
        fs.copyFileSync(path.join(releaseDir, setupFile), destination);
        console.log(`💾 Скопировано на рабочий стол: ${destination}`);
      } catch (error) {
        console.log('⚠️  Не удалось скопировать файл на рабочий стол:', error.message);
      }
    }
  }

} catch (error) {
  console.error('❌ Ошибка при создании установщика:', error.message);
  process.exit(1);
}

console.log('🏁 Завершено.');