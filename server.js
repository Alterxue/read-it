const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Use stealth plugin to bypass Cloudflare detection
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'articles.json');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Load articles from file
function loadArticles() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Error loading articles:', err.message);
    }
    return [];
}

// Save articles to file
function saveArticles() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(articles, null, 2));
    } catch (err) {
        console.error('Error saving articles:', err.message);
    }
}

// Persistent storage
let articles = loadArticles();
let nextId = articles.length > 0 ? Math.max(...articles.map(a => a.id)) + 1 : 1;

// Get all articles list
app.get('/api/articles', (req, res) => {
    const list = articles.map(a => ({
        id: a.id,
        title: a.title,
        site_name: a.site_name,
        created_at: a.created_at
    }));
    res.json(list.reverse()); // newest first
});

// Get single article by id
app.get('/api/articles/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const article = articles.find(a => a.id === id);
    if (article) {
        res.json(article);
    } else {
        res.status(404).json({ error: 'Article not found' });
    }
});

// Delete article by id
app.delete('/api/articles/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const index = articles.findIndex(a => a.id === id);
    if (index !== -1) {
        articles.splice(index, 1);
        saveArticles(); // Save to file
        console.log(`🗑️ Article ${id} deleted`);
        res.json({ message: 'Article deleted successfully' });
    } else {
        res.status(404).json({ error: 'Article not found' });
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
        // Use puppeteer with stealth to bypass Cloudflare protection
        console.log(`Fetching: ${url}`);
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
        
        // Find next chapter link before getting content
        const nextChapterUrl = await page.evaluate(() => {
            // Chinese patterns for next chapter
            const chinesePatterns = ['下一章', '下一页', '下章', '下页', '下一节', '继续阅读', '下一篇'];
            // English patterns
            const englishPatterns = ['next chapter', 'next page', 'next'];
            
            const links = Array.from(document.querySelectorAll('a'));
            
            // First try: exact Chinese text match
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
            
            // Second try: English text match
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
            
            // Third try: common CSS selectors
            const selectors = [
                'a.next', 'a#next', '.next a', '#next a',
                'a[rel="next"]', 'a.nextchapter', 'a.next-chapter',
                '.chapter-nav a:last-child', '.pagination a:last-child'
            ];
            
            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.href) {
                        return el.href;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            return null;
        });
        
        console.log(`Next chapter URL: ${nextChapterUrl || 'not found'}`);
        
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
                const article = {
                    id: nextId++,
                    title: title.trim(),
                    content: body.innerHTML,
                    excerpt: body.textContent?.substring(0, 200).trim() || '',
                    site_name: new URL(url).hostname,
                    original_url: url,
                    next_chapter_url: nextChapterUrl,
                    created_at: new Date().toISOString()
                };
                articles.push(article);
                saveArticles();
                console.log(`✅ Article saved (fallback): ${article.title}`);
                return res.json({ message: 'Article saved successfully', data: article });
            }
            
            console.log('All extraction methods failed');
            return res.status(500).json({ error: 'Failed to parse article - no content found' });
        }

        // Save to memory storage
        const article = {
            id: nextId++,
            title: parsed.title,
            content: parsed.content,
            excerpt: parsed.excerpt,
            site_name: parsed.siteName || new URL(url).hostname,
            original_url: url,
            next_chapter_url: nextChapterUrl,
            created_at: new Date().toISOString()
        };

        articles.push(article);
        saveArticles();

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