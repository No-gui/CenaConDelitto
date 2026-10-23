require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { Telegraf } = require('telegraf');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 1. Connessione MySQL
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 2. Inizializzazione Bot Telegram
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error("❌ ERRORE: TELEGRAM_BOT_TOKEN mancante nel file .env");
    process.exit(1);
}
const bot = new Telegraf(token);
console.log("🤖 Bot Telegram avviato...");

// 3. Comando /start <id_giocatore>
bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const giocatoreId = ctx.payload ? ctx.payload.trim() : null;

    if (!giocatoreId) {
        ctx.reply("⚠️ Usa il link personalizzato fornito per registrarti.");
        return;
    }

    try {
        // Cerca il giocatore
        const [rowsGiocatore] = await pool.query('SELECT * FROM giocatori WHERE id = ?', [giocatoreId]);
        if (rowsGiocatore.length === 0) {
            ctx.reply("⚠️ Codice giocatore non valido.");
            return;
        }

        const giocatore = rowsGiocatore[0];

        // Salviamo il telegram_chat_id
        await pool.query('UPDATE giocatori SET telegram_chat_id = ? WHERE id = ?', [chatId, giocatoreId]);

        // Cerca la scheda assegnata tramite la tabella di raccordo 'assegnazioni'
        const [rowsScheda] = await pool.query(`
            SELECT s.* 
            FROM schede_personaggi s
            JOIN assegnazioni a ON s.id = a.scheda_id
            WHERE a.giocatore_id = ?
        `, [giocatoreId]);

        if (rowsScheda.length === 0) {
            await ctx.replyWithMarkdown(`🎉 Benvenuto/a *${giocatore.nome} ${giocatore.cognome}*!\n\n⚠️ Non ti è ancora stato assegnato un ruolo per la serata.`);
            return;
        }

        const s = rowsScheda[0];

        await ctx.replyWithMarkdown(
            `🎉 Benvenuto/a *${giocatore.nome} ${giocatore.cognome}*!\n\n` +
            `🎭 Il tuo ruolo per la cena è: *${s.ruolo}*.\n\n` +
            `✅ Account collegato con successo! Di seguito la tua scheda segreta.`
        );

        const testoScheda = 
`📜 *LA TUA SCHEDA PERSONAGGIO*\n\n` +
`👤 *Ruolo:* ${s.ruolo}\n\n` +
`📖 *Profilo:*\n${s.profilo}\n\n` +
`🗣️ *Informazioni Pubbliche:*\n${s.informazioni_pubbliche}\n\n` +
`🔐 *Segreto Personale:*\n${s.segreto_personale}\n\n` +
`🎯 *Obiettivo di Gioco:*\n${s.obiettivo_gioco}\n\n` +
`💡 *Cosa sai:*\n${s.cosa_sa}\n\n` +
`🔎 *Indizio / Rivelazione:*\n${s.indizio_rivelazione}`;

        await ctx.replyWithMarkdown(testoScheda);
        console.log(`🔗 ${giocatore.nome} ${giocatore.cognome} associato a "${s.ruolo}"!`);

    } catch (error) {
        console.error("Errore /start:", error);
        ctx.reply("❌ Errore di sistema. Riprova più tardi.");
    }
});

bot.launch();

// ============================================================
// 4. API PER LA DASHBOARD MASTER
// ============================================================

// Ottieni lista giocatori con ruoli assegnati e schede disponibili
app.get('/api/giocatori', async (req, res) => {
    try {
        // Query con JOIN sulla tabella assegnazioni e schede_personaggi
        const [giocatori] = await pool.query(`
            SELECT 
                g.id, g.nome, g.cognome, g.telefono, g.telegram_chat_id,
                a.scheda_id,
                s.ruolo, s.profilo, s.informazioni_pubbliche, s.segreto_personale, s.obiettivo_gioco
            FROM giocatori g
            LEFT JOIN assegnazioni a ON g.id = a.giocatore_id
            LEFT JOIN schede_personaggi s ON a.scheda_id = s.id
            ORDER BY g.id ASC
        `);

        // Recuperiamo anche l'elenco di tutte le schede per i menu a tendina
        const [schede] = await pool.query('SELECT id, ruolo FROM schede_personaggi ORDER BY id ASC');

        res.json({ giocatori, schede });
    } catch (error) {
        console.error("Errore GET /api/giocatori:", error);
        res.status(500).json({ error: "Errore del server" });
    }
});

// Cambia l'assegnazione del ruolo a un giocatore (Raccordo M2M)
app.post('/api/assegna-ruolo', async (req, res) => {
    const { giocatore_id, scheda_id } = req.body;

    if (!giocatore_id || !scheda_id) {
        return res.status(400).json({ success: false, error: "ID Giocatore e ID Scheda sono obbligatori." });
    }

    try {
        // Rimuoviamo eventuali assegnazioni precedenti per questa scheda o per questo giocatore
        await pool.query('DELETE FROM assegnazioni WHERE giocatore_id = ? OR scheda_id = ?', [giocatore_id, scheda_id]);

        // Inseriamo la nuova assegnazione
        await pool.query('INSERT INTO assegnazioni (giocatore_id, scheda_id) VALUES (?, ?)', [giocatore_id, scheda_id]);

        res.json({ success: true, message: "Ruolo riassegnato con successo!" });
    } catch (error) {
        console.error("Errore riassegnazione ruolo:", error);
        res.status(500).json({ success: false, error: "Errore durante il cambio ruolo." });
    }
});

// Modifica anagrafica giocatore e scheda
app.put('/api/giocatori/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, cognome, telefono, scheda_id, profilo, informazioni_pubbliche, segreto_personale, obiettivo_gioco } = req.body;

    try {
        await pool.query('UPDATE giocatori SET nome = ?, cognome = ?, telefono = ? WHERE id = ?', [nome, cognome, telefono, id]);

        if (scheda_id) {
            await pool.query(
                `UPDATE schede_personaggi 
                 SET profilo = ?, informazioni_pubbliche = ?, segreto_personale = ?, obiettivo_gioco = ? 
                 WHERE id = ?`,
                [profilo || '', informazioni_pubbliche || '', segreto_personale || '', obiettivo_gioco || '', scheda_id]
            );
        }

        res.json({ success: true, message: "Dati aggiornati con successo!" });
    } catch (error) {
        console.error("Errore aggiornamento:", error);
        res.status(500).json({ success: false, error: "Errore durante l'aggiornamento." });
    }
});

// Elimina un giocatore
app.delete('/api/giocatori/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM assegnazioni WHERE giocatore_id = ?', [id]);
        await pool.query('DELETE FROM giocatori WHERE id = ?', [id]);
        res.json({ success: true, message: "Giocatore eliminato con successo!" });
    } catch (error) {
        console.error("Errore eliminazione:", error);
        res.status(500).json({ success: false, error: "Errore eliminazione." });
    }
});

// Invia Messaggio Singolo
app.post('/api/invia-messaggio', async (req, res) => {
    const { id, messaggio } = req.body;
    try {
        const [rows] = await pool.query('SELECT nome, telegram_chat_id FROM giocatori WHERE id = ?', [id]);
        if (rows.length === 0 || !rows[0].telegram_chat_id) {
            return res.status(400).json({ success: false, error: "Giocatore non collegato a Telegram." });
        }

        await bot.telegram.sendMessage(rows[0].telegram_chat_id, `🕵️ *MESSAGGIO DAL MASTER*:\n\n${messaggio}`, { parse_mode: 'Markdown' });
        res.json({ success: true, message: `Messaggio inviato a ${rows[0].nome}!` });
    } catch (error) {
        res.status(500).json({ success: false, error: "Errore invio messaggio." });
    }
});

// Invia Broadcast
app.post('/api/invia-broadcast', async (req, res) => {
    const { messaggio } = req.body;
    try {
        const [rows] = await pool.query('SELECT telegram_chat_id FROM giocatori WHERE telegram_chat_id IS NOT NULL');
        let inviati = 0;
        for (const g of rows) {
            try {
                await bot.telegram.sendMessage(g.telegram_chat_id, `🚨 *COMUNICAZIONE DEL MASTER*:\n\n${messaggio}`, { parse_mode: 'Markdown' });
                inviati++;
            } catch (err) {}
        }
        res.json({ success: true, message: `Messaggio inviato a ${inviati} giocatori!` });
    } catch (error) {
        res.status(500).json({ success: false, error: "Errore broadcast." });
    }
});

// Aggiungi un nuovo giocatore
app.post('/api/giocatori', async (req, res) => {
    const { nome, cognome, telefono } = req.body;

    if (!nome || !cognome) {
        return res.status(400).json({ success: false, error: "Nome e cognome sono obbligatori." });
    }

    try {
        const [result] = await pool.query(
            'INSERT INTO giocatori (nome, cognome, telefono) VALUES (?, ?, ?)',
            [nome, cognome, telefono || '']
        );
        res.json({ success: true, message: "Partecipante aggiunto con successo!", id: result.insertId });
    } catch (error) {
        console.error("Errore aggiunta giocatore:", error);
        res.status(500).json({ success: false, error: "Errore del server durante l'aggiunta." });
    }
});

// Aggiungi un nuovo ruolo/scheda personaggio
app.post('/api/schede', async (req, res) => {
    const { ruolo, profilo, informazioni_pubbliche, segreto_personale, obiettivo_gioco, cosa_sa, indizio_rivelazione } = req.body;

    if (!ruolo) {
        return res.status(400).json({ success: false, error: "Il nome del ruolo è obbligatorio." });
    }

    try {
        const [result] = await pool.query(
            `INSERT INTO schede_personaggi (ruolo, profilo, informazioni_pubbliche, segreto_personale, obiettivo_gioco, cosa_sa, indizio_rivelazione) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                ruolo, 
                profilo || '', 
                informazioni_pubbliche || '', 
                segreto_personale || '', 
                obiettivo_gioco || '', 
                cosa_sa || '', 
                indizio_rivelazione || ''
            ]
        );
        res.json({ success: true, message: "Ruolo aggiunto con successo!", id: result.insertId });
    } catch (error) {
        console.error("Errore aggiunta ruolo:", error);
        res.status(500).json({ success: false, error: "Errore del server durante l'aggiunta del ruolo." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Server web su http://localhost:${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));