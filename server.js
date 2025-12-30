require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { Pool } = require('pg');

// Use stealth plugin to bypass Cloudflare detection
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

// PostgreSQL connection pool
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5433,
    database: process.env.DB_NAME || 'my_reader',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || ''
});

// Test database connection and create tables
pool.query('SELECT NOW()', async (err, res) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Database connected successfully');
        // Create books table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS books (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                site_name TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                chapter_count INTEGER DEFAULT 0
            )
        `);
        // Add book_id and chapter_order to articles if not exists
        await pool.query(`
            ALTER TABLE articles ADD COLUMN IF NOT EXISTS book_id INTEGER REFERENCES books(id) ON DELETE CASCADE
        `).catch(() => {});
        await pool.query(`
            ALTER TABLE articles ADD COLUMN IF NOT EXISTS chapter_order INTEGER DEFAULT 0
        `).catch(() => {});
        console.log('✅ Database tables ready');
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ BOOKS API ============

// Get all books with chapter count
app.get('/api/books', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, COUNT(a.id) as chapter_count 
            FROM books b 
            LEFT JOIN articles a ON a.book_id = b.id 
            GROUP BY b.id 
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching books:', err.message);
        res.status(500).json({ error: 'Failed to fetch books' });
    }
});

// Get chapters of a book
app.get('/api/books/:id/chapters', async (req, res) => {
    const bookId = parseInt(req.params.id);
    try {
        const result = await pool.query(
            'SELECT id, title, chapter_order, created_at, next_url FROM articles WHERE book_id = $1 ORDER BY chapter_order ASC',
            [bookId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching chapters:', err.message);
        res.status(500).json({ error: 'Failed to fetch chapters' });
    }
});

// Get single chapter by id
app.get('/api/books/:bookId/chapter/:chapterId', async (req, res) => {
    const chapterId = parseInt(req.params.chapterId);
    try {
        const result = await pool.query('SELECT * FROM articles WHERE id = $1', [chapterId]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: 'Chapter not found' });
        }
    } catch (err) {
        console.error('Error fetching chapter:', err.message);
        res.status(500).json({ error: 'Failed to fetch chapter' });
    }
});

// Delete a book and all its chapters
app.delete('/api/books/:id', async (req, res) => {
    const bookId = parseInt(req.params.id);
    try {
        await pool.query('DELETE FROM books WHERE id = $1', [bookId]);
        console.log(`🗑️ Book ${bookId} and all chapters deleted`);
        res.json({ message: 'Book deleted successfully' });
    } catch (err) {
        console.error('Error deleting book:', err.message);
        res.status(500).json({ error: 'Failed to delete book' });
    }
});

// get the status of the downloading mission
let downloadInProgress = {};

app.post('/api/books/download', async (req, res) => {
    const { url, bookName, maxChapters = 200 } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // Generate a unique download ID
    const downloadId = Date.now().toString();
    downloadInProgress[downloadId] = {
        status: 'downloading',
        currentChapter: 0,
        totalChapters: 0,
        bookId: null,
        error: null
    };

    // Start download in background
    res.json({ downloadId, message: 'Download started' });

    // Process download
    downloadBook(downloadId, url, bookName, maxChapters);
});

// Check download status
app.get('/api/books/download/:id', (req, res) => {
    const downloadId = req.params.id;
    const status = downloadInProgress[downloadId];
    if (status) {
        res.json(status);
    } else {
        res.status(404).json({ error: 'Download not found' });
    }
});

// Background download function
async function downloadBook(downloadId, startUrl, bookName, maxChapters) {
    let browser;
    try {
        // Create the book first
        const siteName = new URL(startUrl).hostname;
        const finalBookName = bookName || `Book from ${siteName}`;
        
        const bookResult = await pool.query(
            'INSERT INTO books (name, site_name) VALUES ($1, $2) RETURNING *',
            [finalBookName, siteName]
        );
        const bookId = bookResult.rows[0].id;
        downloadInProgress[downloadId].bookId = bookId;

        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        let currentUrl = startUrl;
        let chapterOrder = 1;

        while (currentUrl && chapterOrder <= maxChapters) {
            downloadInProgress[downloadId].currentChapter = chapterOrder;
            console.log(`Downloading chapter ${chapterOrder}: ${currentUrl}`);

            try {
                const { article, nextUrl } = await fetchChapter(browser, currentUrl);
                
                // Save to database with book_id
                await pool.query(
                    `INSERT INTO articles (title, content, excerpt, site_name, original_url, next_url, book_id, chapter_order)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [article.title, article.content, article.excerpt, article.siteName, currentUrl, nextUrl, bookId, chapterOrder]
                );

                console.log(`Chapter ${chapterOrder} saved: ${article.title}`);
                
                currentUrl = nextUrl;
                chapterOrder++;
                downloadInProgress[downloadId].totalChapters = chapterOrder - 1;

                // Small delay to avoid overwhelming the server
                await new Promise(r => setTimeout(r, 1000));
            } catch (err) {
                console.error(`Error fetching chapter ${chapterOrder}:`, err.message);
                break;
            }
        }

        // Update book chapter count
        await pool.query(
            'UPDATE books SET chapter_count = $1 WHERE id = $2',
            [chapterOrder - 1, bookId]
        );

        downloadInProgress[downloadId].status = 'completed';
        console.log(`Book download completed: ${chapterOrder - 1} chapters`);

    } catch (error) {
        console.error('Download error:', error.message);
        downloadInProgress[downloadId].status = 'error';
        downloadInProgress[downloadId].error = error.message;
    } finally {
        if (browser) await browser.close();
        setTimeout(() => delete downloadInProgress[downloadId], 300000);
    }
}

// Helper function to fetch a single chapter
async function fetchChapter(browser, url) {
    const page = await browser.newPage();
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 
        'Accept-Language': 'en-US,en;q=0.9'
    });

    // Bypass webdriver detection
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en', 'zh', 'zh-CN'] });
        window.chrome = { runtime: {} };
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

    // Wait for Cloudflare challenge to complete
    let retries = 0;
    const cloudflarePatterns = [
        'Just a moment', 
        'Checking your browser', 
        'Verifying you are human',
        'Please wait',
        'DDoS protection',
        'Enable JavaScript',
        'security of your connection'
    ];
    while (retries < 20) {
        const content = await page.content();
        const hasCloudflare = cloudflarePatterns.some(p => content.includes(p));
        if (!hasCloudflare && content.length > 5000) break;
        console.log(`⏳ Waiting for Cloudflare... (${retries + 1}/20)`);
        await new Promise(r => setTimeout(r, 3000));
        retries++;
    }
    await new Promise(r => setTimeout(r, 2000));

    // Find next chapter URL
    const nextUrl = await page.evaluate(() => {
        const patterns = ['next chapter', 'next page', 'next', '下一章', '下一页', '下章', '下页', '下一节', '继续阅读', '下一篇'];
        const links = Array.from(document.querySelectorAll('a'));
        for (const link of links) {
            const text = (link.textContent?.trim() || '').toLowerCase();
            const href = link.getAttribute('href');
            if (!href || href === '#' || href.startsWith('javascript:')) continue;
            for (const pattern of patterns) {
                if (text.includes(pattern.toLowerCase())) {
                    try { return new URL(href, window.location.href).href; } catch (e) { continue; }
                }
            }
        }
        return null;
    });

    const html = await page.content();
    await page.close();

    // Parse with Readability
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();

    if (!parsed || !parsed.content) {
        throw new Error('Failed to parse chapter content');
    }

    return {
        article: {
            title: parsed.title,
            content: parsed.content,
            excerpt: parsed.excerpt,
            siteName: parsed.siteName || new URL(url).hostname
        },
        nextUrl
    };
}

// Continue downloading chapters for an existing book
app.post('/api/books/:id/continue', async (req, res) => {
    const bookId = parseInt(req.params.id);
    const { url, maxChapters = 100 } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    // Find current max chapter_order for this book
    let startOrder = 1;
    try {
        const result = await pool.query('SELECT MAX(chapter_order) as max_order FROM articles WHERE book_id = $1', [bookId]);
        if (result.rows.length > 0 && result.rows[0].max_order) {
            startOrder = result.rows[0].max_order + 1;
        }
    } catch (err) {
        return res.status(500).json({ error: 'Failed to get chapter order' });
    }
    // Start background download
    const downloadId = Date.now().toString();
    downloadInProgress[downloadId] = {
        status: 'downloading',
        currentChapter: startOrder,
        totalChapters: 0,
        bookId,
        error: null
    };
    res.json({ downloadId, message: 'Continue download started' });
    continueDownloadBook(downloadId, url, bookId, startOrder, maxChapters);
});

// Background function for continuing book download
async function continueDownloadBook(downloadId, startUrl, bookId, startOrder, maxChapters) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        let currentUrl = startUrl;
        let chapterOrder = startOrder;
        while (currentUrl && chapterOrder < startOrder + maxChapters) {
            downloadInProgress[downloadId].currentChapter = chapterOrder;
            console.log(`Continuing download chapter ${chapterOrder}: ${currentUrl}`);
            try {
                const { article, nextUrl } = await fetchChapter(browser, currentUrl);
                await pool.query(
                    `INSERT INTO articles (title, content, excerpt, site_name, original_url, next_url, book_id, chapter_order)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [article.title, article.content, article.excerpt, article.siteName, currentUrl, nextUrl, bookId, chapterOrder]
                );
                console.log(`Chapter ${chapterOrder} saved: ${article.title}`);
                currentUrl = nextUrl;
                chapterOrder++;
                downloadInProgress[downloadId].totalChapters = chapterOrder - startOrder;
                await new Promise(r => setTimeout(r, 1000));
            } catch (err) {
                console.error(`Error fetching chapter ${chapterOrder}:`, err.message);
                break;
            }
        }
        // Update book chapter count
        const countResult = await pool.query('SELECT COUNT(*) FROM articles WHERE book_id = $1', [bookId]);
        const chapterCount = parseInt(countResult.rows[0].count) || 0;
        await pool.query('UPDATE books SET chapter_count = $1 WHERE id = $2', [chapterCount, bookId]);
        downloadInProgress[downloadId].status = 'completed';
        console.log(`Continue book download completed: ${chapterOrder - startOrder} chapters`);
    } catch (error) {
        console.error('Continue download error:', error.message);
        downloadInProgress[downloadId].status = 'error';
        downloadInProgress[downloadId].error = error.message;
    } finally {
        if (browser) await browser.close();
        setTimeout(() => delete downloadInProgress[downloadId], 300000);
    }
}


// ============ ARTICLES API ============

// Get all standalone articles (not part of any book)
app.get('/api/articles', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, title, site_name, created_at FROM articles WHERE book_id IS NULL ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching articles:', err.message);
        res.status(500).json({ error: 'Failed to fetch articles' });
    }
});

// Get single article by id
app.get('/api/articles/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const result = await pool.query('SELECT * FROM articles WHERE id = $1', [id]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: 'Article not found' });
        }
    } catch (err) {
        console.error('Error fetching article:', err.message);
        res.status(500).json({ error: 'Failed to fetch article' });
    }
});

// Delete article by id
app.delete('/api/articles/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const result = await pool.query('DELETE FROM articles WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length > 0) {
            console.log(`🗑️ Article ${id} deleted`);
            res.json({ message: 'Article deleted successfully' });
        } else {
            res.status(404).json({ error: 'Article not found' });
        }
    } catch (err) {
        console.error('Error deleting article:', err.message);
        res.status(500).json({ error: 'Failed to delete article' });
    }
});

// Save new article from URL (standalone, not part of a book)
app.post('/api/save', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    let browser;
    try {
        console.log(`🔍 Fetching: ${url}`);
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080']
        });
        
        const { article, nextUrl } = await fetchChapter(browser, url);
        
        const result = await pool.query(
            `INSERT INTO articles (title, content, excerpt, site_name, original_url, next_url)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [article.title, article.content, article.excerpt, article.siteName, url, nextUrl]
        );

        console.log(`✅ Article saved: ${article.title}`);
        res.json({ message: 'Article saved successfully', data: result.rows[0] });

    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch article', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Server running at: http://localhost:${PORT}`);
});