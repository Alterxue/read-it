# 📚 Read-It Application

A clean web article reader with PostgreSQL storage.

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure database
cp .env.example .env
# Edit .env and set your PostgreSQL password

# 3. Start the application
node server.js

# 4. Open browser
http://localhost:3000
```

## 📝 Features

- 📖 Scrape and save articles from URLs
- 📚 View saved articles list
- 🔍 Clean reading format
- 🗑️ Delete articles
- ➡️ Auto-detect next chapter links
- 🛡️ Bypass Cloudflare protection

## 📁 Project Structure

```
read-it/
├── server.js       # Express server
├── .env            # Database config
├── package.json    # Dependencies
└── public/
    └── index.html  # Frontend
```

## 🗄️ Database Setup

```bash
# Create database and table
sudo -u postgres psql -c "CREATE DATABASE my_reader;"
sudo -u postgres psql -d my_reader -c "
CREATE TABLE articles (
    id SERIAL PRIMARY KEY,
    title TEXT,
    original_url TEXT,
    content TEXT,
    excerpt TEXT,
    site_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    next_url TEXT
);"
```

## ⚙️ Configuration

`.env` file:

```
DB_HOST=localhost
DB_PORT=5433
DB_NAME=my_reader
DB_USER=postgres
DB_PASSWORD=your_password
```
