// Cache all chapters of a book for offline use
async function cacheAllChapters(bookId, btn) {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.innerHTML = '<span class="loading-spinner"></span>缓存中...';
    try {
        // Fetch all chapters
        const res = await fetch(`/api/books/${bookId}/chapters`);
        const chapters = await res.json();
        let cached = 0;
        for (let i = 0; i < chapters.length; i++) {
            const c = chapters[i];
            // Fetch chapter content to trigger Service Worker cache
            await fetch(`/api/articles/${c.id}`);
            cached++;
            btn.innerHTML = `<span class='loading-spinner'></span>RUNNING (${cached}/${chapters.length})...`;
        }
        btn.innerHTML = '✅ done';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
    } catch (err) {
        btn.textContent = '❌ failure';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
    }
}
