# 📚 Read-It Application

A clean web article and book reader with PostgreSQL storage.

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

- 📖 Save single articles from URLs
- 📚 Download entire books (auto-chapter crawling)
- 📚 Continue downloading chapters for existing books (auto-detect next chapter)
- 🔍 Clean reading format
- 🗑️ Delete articles or books
- ➡️ Auto-detect next chapter links
- 🛡️ Bypass Cloudflare protection
- ✈️ Offline reading (PWA support)
- 📥 **Cache All Chapters to Device**: One-click button to cache all chapters of a book for offline reading. Button is available in the Bookshelf tab for each book. Progress and completion are shown in the UI. Service Worker ensures chapters are available offline.

## 📁 Project Structure

```
read-it/
├── server.js       # Express server (PostgreSQL)
├── .env            # Database config
├── package.json    # Dependencies
└── public/
    └── index.html  # Frontend
```

## 🗄️ Database Setup

```bash
# Create database and tables
sudo -u postgres psql -c "CREATE DATABASE my_reader;"
sudo -u postgres psql -d my_reader -c "
CREATE TABLE books (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    site_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    chapter_count INTEGER DEFAULT 0
);
CREATE TABLE articles (
    id SERIAL PRIMARY KEY,
    title TEXT,
    original_url TEXT,
    content TEXT,
    excerpt TEXT,
    site_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    next_url TEXT,
    book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
    chapter_order INTEGER DEFAULT 0
);
"
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

## 🖥️ UI Overview

- **Articles Tab**: Save and view single articles
- **Bookshelf Tab**: Download whole books, view chapters, continue download from last chapter
- **Continue Download**: No need to input URL, system auto-detects last chapter's next_url
- **Progress**: Real-time download progress for books and chapters

## 📚 Book Download & Continue API

- **Download Book**: `/api/books/download` (POST)
    - `{ url, bookName, maxChapters }`
- **Continue Book Download**: `/api/books/:id/continue` (POST)
    - `{ url, maxChapters }` (front-end auto-fills url)
- **Check Progress**: `/api/books/download/:id` (GET)

## 📱 Offline Reading

- PWA support: Install as app, cache articles/books for offline use
- **Cache All Chapters**: Use the "Cache All Chapters to Device" button in the Bookshelf tab to make all chapters of a book available offline. Progress is shown during caching. Chapters will be readable offline after caching completes.

---

**Version**: 2.0.0 (PostgreSQL, Books/Articles, Continue Download)
