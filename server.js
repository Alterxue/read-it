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

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Database connected successfully');
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Get all articles list
app.get('/api/articles', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, title, site_name, created_at FROM articles ORDER BY created_at DESC'
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

// Save new article from URL
app.post('/api/save', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    let browser;
    try {
        console.log(`🔍 Fetching: ${url}`);
        browser = await puppeteer.launch({ 
            headless: 'new', // Run in background without popup
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080'
            ]
        });
        const page = await browser.newPage();
        
        // Set viewport and user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Set extra headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
        });
        
        // Navigate and wait for content to load
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
        
        // Wait for Cloudflare challenge to complete
        let retries = 0;
        while (retries < 15) {
            const content = await page.content();
            if (!content.includes('Just a moment') && 
                !content.includes('Checking your browser') &&
                !content.includes('Please wait') &&
                !content.includes('Verifying you are human')) {
                break;
            }
            console.log(`Waiting for Cloudflare... (${retries + 1}/15)`);
            await new Promise(r => setTimeout(r, 3000));
            retries++;
        }
        
        // Extra wait for page to fully load
        await new Promise(r => setTimeout(r, 2000));
        
        // Find next chapter link - using same logic as JSON version
        const nextChapterUrl = await page.evaluate(() => {
            const chinesePatterns = ['下一章', '下一页', '下章', '下页', '下一节', '继续阅读', '下一篇'];
            const englishPatterns = ['next chapter', 'next page', 'next'];
            const links = Array.from(document.querySelectorAll('a'));
            
            // Try Chinese patterns first
            for (const link of links) {
                const text = link.textContent?.trim() || '';
                const href = link.getAttribute('href');
                if (!href || href === '#' || href.startsWith('javascript:')) continue;
                
                for (const pattern of chinesePatterns) {
                    if (text.includes(pattern)) {
                        try {
                            return new URL(href, window.location.href).href;
                        } catch (e) {
                            continue;
                        }
                    }
                }
            }
            
            // Try English patterns
            for (const link of links) {
                const text = link.textContent?.trim().toLowerCase() || '';
                const href = link.getAttribute('href');
                if (!href || href === '#' || href.startsWith('javascript:')) continue;
                
                for (const pattern of englishPatterns) {
                    if (text.includes(pattern)) {
                        try {
                            return new URL(href, window.location.href).href;
                        } catch (e) {
                            continue;
                        }
                    }
                }
            }
            
            // Try CSS selectors as last resort
            const selectors = ['a.next', 'a#next', '.next-chapter', 'a[rel="next"]'];
            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.href) return el.href;
                } catch (e) {
                    continue;
                }
            }
            
            return null;
        });
        
        console.log(`Next chapter: ${nextChapterUrl || 'not found'}`);
        
        const html = await page.content();
        await browser.close();
        browser = null;

        console.log(`Fetched ${html.length} bytes from ${url}`);

        // Parse HTML with Readability
        const dom = new JSDOM(html, { url: url });
        const reader = new Readability(dom.window.document);
        const parsed = reader.parse();

        if (!parsed || !parsed.content) {
            console.log('Readability failed, trying fallback extraction...');
            const doc = dom.window.document;
            const title = doc.querySelector('title')?.textContent || 
                          doc.querySelector('h1')?.textContent || 'Untitled';
            
            const selectors = ['article', '.article', '.content', '#content', '.post', '.entry', '.text', 'main', '.main', '#main', 'body'];
            let body = null;
            for (const sel of selectors) {
                body = doc.querySelector(sel);
                if (body && body.textContent.trim().length > 100) break;
            }
            
            if (body && body.innerHTML.trim().length > 0) {
                const articleTitle = title.trim();
                const content = body.innerHTML;
                const excerpt = body.textContent?.substring(0, 200).trim() || '';
                const siteName = new URL(url).hostname;
                
                const result = await pool.query(
                    `INSERT INTO articles (title, content, excerpt, site_name, original_url, next_url)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                    [articleTitle, content, excerpt, siteName, url, nextChapterUrl]
                );
                const article = result.rows[0];
                console.log(`✅ Article saved (fallback): ${article.title}`);
                return res.json({ message: 'Article saved successfully', data: article });
            }
            
            console.log('All extraction methods failed');
            return res.status(500).json({ error: 'Failed to parse article - no content found' });
        }

        // Save to database
        const siteName = parsed.siteName || new URL(url).hostname;
        const result = await pool.query(
            `INSERT INTO articles (title, content, excerpt, site_name, original_url, next_url)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [parsed.title, parsed.content, parsed.excerpt, siteName, url, nextChapterUrl]
        );
        const article = result.rows[0];

        console.log(`✅ Article saved: ${article.title}`);
        res.json({ message: 'Article saved successfully', data: article });

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