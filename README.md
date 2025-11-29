# 📚 Read-It Application - JSON Version

This is the JSON storage version of the Read-It application (original version).

## 🚀 Quick Start

```bash
# 1. Start the application
node server.js

# 2. Open in browser
http://localhost:3000
```

## 📝 Features

- 📖 Scrape and save articles from URLs
- 📚 View list of saved articles
- 🔍 View article details
- 🗑️ Delete unwanted articles
- ➡️ Jump to next chapter

## 📁 File Structure

```
read-it/
├── server.js          # Express server (JSON storage)
├── articles.json      # Article data storage
├── package.json       # npm dependencies
├── public/
│   └── index.html     # Frontend page
└── node_modules/      # Dependencies
```

## 💾 Data Storage

All articles are saved in the `articles.json` file.

## 🛑 Stop the Application

Press `Ctrl + C` in the terminal to stop the server.

---

**Version**: 1.0.0 (JSON Storage)  
**Status**: ✅ Ready to use
