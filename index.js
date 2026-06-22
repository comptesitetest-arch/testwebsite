import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { google } from "googleapis";
import fs from "fs";

// =======================================================
// 1. CONFIGURATION & INITIALISATION
// =======================================================

const SERVICE_ACCOUNT_KEY_CONTENT = JSON.parse(
    process.env.SERVICE_ACCOUNT_KEY || fs.readFileSync("./google-service-account.json", "utf8")
);

admin.initializeApp({
    credential: admin.credential.cert(SERVICE_ACCOUNT_KEY_CONTENT), 
});
const db = admin.firestore();

const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT_KEY_CONTENT,
    scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_KEY || "Site2Test";
const CALENDAR_ID = process.env.CALENDAR_ID || "compte.site.test@gmail.com";
const INSTITUT_NAME = "Site Test";

// =======================================================
// 2. STYLES DES EMAILS (DESIGN PREMIUM ESTHÉTIQUE)
// =======================================================

const emailTheme = {
    wrapper: "font-family:'Helvetica Neue',Arial,sans-serif; width:100%; background-color:#fbf9f6; padding:20px 0;",
    container: "max-width:600px; margin:0 auto; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 15px rgba(0,0,0,0.02); border: 1px solid #f0e9e1;",
    header: "background-color:#2c2c2c; padding:35px; text-align:center;",
    body: "padding:40px 30px; text-align:center; color:#4a4a4a; line-height: 1.6;",
    h1: "color:#f4d0bc; margin:0; letter-spacing:5px; font-size:22px; text-transform:uppercase; font-weight: 300;",
    h2: "font-size:20px; margin-bottom:20px; color:#2c2c2c; font-weight: 400; letter-spacing: 1px;",
    otpBox: "background-color:#fdfbf9; border:1px solid #eadecc; border-radius:12px; padding:20px; margin:20px 0; font-size:32px; font-weight:bold; letter-spacing:8px; color: #b8977e;",
    button: "display:inline-block; padding:15px 30px; background-color:#2c2c2c; color:#fff; text-decoration:none; border-radius:8px; font-weight:bold; margin-top:20px;",
    footer: "padding:20px; text-align:center; font-size:12px; color:#b5afaa; background-color: #faf7f2;"
};

// =======================================================
// 3. FONCTIONS DE MAINTENANCE
// =======================================================

async function cleanupOldAppointments() {
    const nowParis = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    const todayParis = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const currentTimeParis = nowParis.getHours().toString().padStart(2, '0') + ":" + nowParis.getMinutes().toString().padStart(2, '0');

    try {
        const snapshotOld = await db.collection("appointments").where("date", "<", todayParis).get();
        const snapshotToday = await db.collection("appointments").where("date", "==", todayParis).get();

        const batch = db.batch();
        let count = 0;

        snapshotOld.docs.forEach(doc => { batch.delete(doc.ref); count++; });
        snapshotToday.docs.forEach(doc => {
            if (doc.data().time <= currentTimeParis) { batch.delete(doc.ref); count++; }
        });

        if (count === 0) return;
        await batch.commit();
        console.log(`✅ Nettoyage : ${count} réservations passées supprimées.`);
    } catch (error) { console.error("❌ Erreur nettoyage:", error); }
}

async function sendReminders() {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + (24 * 60 * 60 * 1000));
    const targetDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(tomorrow);
    
    const targetHour = tomorrow.getHours().toString().padStart(2, '0');
    const securityDelay = 60 * 60 * 1000; 

    try {
        const snapshot = await db.collection("appointments").where("date", "==", targetDay).where("reminderSent", "==", false).get();

        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (data.time.startsWith(targetHour + ":")) {
                const createdAt = data.createdAt.toDate();
                if (now.getTime() - createdAt.getTime() < securityDelay) continue;

                await fetch("https://api.brevo.com/v3/smtp/email", {
                    method: "POST",
                    headers: { "accept": "application/json", "api-key": process.env.MAIL_PASS, "content-type": "application/json" },
                    body: JSON.stringify({
                        sender: { name: INSTITUT_NAME, email: process.env.SENDER_EMAIL },
                        to: [{ email: data.email, name: data.clientName }],
                        subject: `🔔 Rappel : Votre rendez-vous de demain - ${INSTITUT_NAME}`,
                        htmlContent: `
                            <div style="${emailTheme.wrapper}">
                                <div style="${emailTheme.container}">
                                    <div style="${emailTheme.header}"><h1 style="${emailTheme.h1}">${INSTITUT_NAME}</h1></div>
                                    <div style="${emailTheme.body}">
                                        <h2 style="${emailTheme.h2}">À DEMAIN ✨</h2>
                                        <p>Bonjour <b>${data.clientName}</b>,</p>
                                        <p>Nous vous rappelons votre moment prévu demain à :</p>
                                        <div style="font-size:36px; font-weight:300; margin:20px 0; color: #2c2c2c;">${data.time}</div>
                                        <p style="color:#8a847f;">📍 À l'institut</p>
                                    </div>
                                    <div style="${emailTheme.footer}">En cas d'empêchement, merci de nous prévenir au moins 24h à l'avance.</div>
                                </div>
                            </div>`
                    })
                });
                await doc.ref.update({ reminderSent: true });
            }
        }
    } catch (error) { console.error("❌ Erreur rappels:", error); }
}

setInterval(() => { sendReminders(); cleanupOldAppointments(); }, 300000);

// =======================================================
// 4. ROUTES API
// =======================================================

app.post("/api/verify-request", async (req, res) => {
    const { email, clientName, date, time, phone } = req.body;
    if (!email || !date || !time || !clientName || !phone) return res.status(400).json({ success: false });

    try {
        const blockedDoc = await db.collection("blacklist").doc(email).get();
        if (blockedDoc.exists) {
            return res.status(200).json({ 
                success: false, 
                message: "Les réservations en ligne sont indisponibles pour ce compte." 
            });
        }

        const checkEmail = await db.collection("appointments").where("email", "==", email).limit(1).get();
        if (!checkEmail.empty) {
            return res.status(200).json({ 
                success: false, 
                message: "Vous avez déjà un rendez-vous planifié avec cette adresse e-mail." 
            });
        }

        const checkPhone = await db.collection("appointments").where("phone", "==", phone).limit(1).get();
        if (!checkPhone.empty) {
            return res.status(200).json({ 
                success: false, 
                message: "Ce numéro de téléphone est déjà lié à un rendez-vous actif." 
            });
        }

        const existingSlot = await db.collection("appointments").where("date", "==", date).where("time", "==", time).get();
        if (!existingSlot.empty) {
            return res.status(200).json({ 
                success: false, 
                message: "Ce créneau vient tout juste d'être réservé." 
            });
        }

        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        console.log(`[OTP] Généré pour ${email} : ${otp}`);

        await db.collection("temp_verifications").doc(email).set({ 
            otp, clientName, date, time, phone, createdAt: new Date() 
        });

        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "accept": "application/json", "api-key": process.env.MAIL_PASS, "content-type": "application/json" },
            body: JSON.stringify({
                sender: { name: INSTITUT_NAME, email: process.env.SENDER_EMAIL },
                to: [{ email, name: clientName }],
                subject: `Code de validation – ${INSTITUT_NAME}`,
                htmlContent: `
                    <div style="${emailTheme.wrapper}">
                        <div style="${emailTheme.container}">
                            <div style="${emailTheme.header}"><h1 style="${emailTheme.h1}">${INSTITUT_NAME}</h1></div>
                            <div style="${emailTheme.body}">
                                <h2 style="${emailTheme.h2}">VÉRIFICATION</h2>
                                <p>Bonjour ${clientName}, voici votre code de sécurité pour confirmer votre demande de rendez-vous :</p>
                                <div style="${emailTheme.otpBox}">${otp}</div>
                                <p style="font-size:13px; color:#999;">Ce code confidentiel est valable 10 minutes.</p>
                            </div>
                        </div>
                    </div>`
            })
        });

        res.json({ success: true });

    } catch (error) { 
        console.error("Erreur serveur:", error);
        res.status(500).json({ success: false, message: "Une erreur est survenue sur le serveur." }); 
    }
});

app.post("/api/verify-confirm", async (req, res) => {
    const { email, code } = req.body;
    try {
        const vDoc = await db.collection("temp_verifications").doc(email).get();
        if (!vDoc.exists) return res.status(400).json({ success: false });
        
        const storedOtp = vDoc.data().otp;
        if (storedOtp !== code) return res.status(400).json({ success: false });

        const data = vDoc.data();
        const startISO = `${data.date}T${data.time}:00`;
        const [h, m] = data.time.split(':').map(Number);
        const endH = String(m === 30 ? h + 1 : h).padStart(2, '0');
        const endM = m === 30 ? '00' : '30';
        const endISO = `${data.date}T${endH}:${endM}:00`;
        
        const gEvent = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                summary: `✨ Prestation : ${data.clientName}`,
                description: `Tel: ${data.phone}`,
                start: { dateTime: startISO, timeZone: "Europe/Paris" },
                end: { dateTime: endISO, timeZone: "Europe/Paris" },
            },
        });

        await db.collection("appointments").add({
            ...data, email: email, calendarEventId: gEvent.data.id, reminderSent: false, createdAt: new Date()
        });

        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "accept": "application/json", "api-key": process.env.MAIL_PASS, "content-type": "application/json" },
            body: JSON.stringify({
                sender: { name: INSTITUT_NAME, email: process.env.SENDER_EMAIL },
                to: [{ email, name: data.clientName }, { email: process.env.SENDER_EMAIL, name: "Notification" }],
                subject: `✅ Confirmation de rendez-vous – ${INSTITUT_NAME}`,
                htmlContent: `
                    <div style="${emailTheme.wrapper}">
                        <div style="${emailTheme.container}">
                            <div style="${emailTheme.header}"><h1 style="${emailTheme.h1}">${INSTITUT_NAME}</h1></div>
                            <div style="${emailTheme.body}">
                                <h2 style="${emailTheme.h2}; color:#9e775d;">VOTRE VENUE EST CONFIRMÉE</h2>
                                <p>Rendez-vous validé avec succès pour <b>${data.clientName}</b>.</p>
                                <div style="background:#faf7f2; padding:20px; border-radius:12px; margin:20px 0; text-align:left; border: 1px solid #f0e9e1;">
                                    <p style="margin:5px 0; color:#4a4a4a;">📅 <b>Date :</b> ${data.date}</p>
                                    <p style="margin:5px 0; color:#4a4a4a;">🕒 <b>Heure :</b> ${data.time}</p>
                                    <p style="margin:5px 0; color:#4a4a4a;">📍 <b>Lieu :</b> À l'institut</p>
                                </div>
                                <p style="font-size:13px; color:#8a847f;">Merci de vous présenter 5 minutes avant l'heure de votre soin.</p>
                            </div>
                        </div>
                    </div>`
            })
        });

        await db.collection("temp_verifications").doc(email).delete();
        res.json({ success: true });
    } catch (error) { 
        console.error("Erreur confirm:", error);
        res.status(500).json({ success: false }); 
    }
});

// --- ROUTES ADMIN ---

const checkAuth = (req, res, next) => {
    if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
    res.status(401).json({ error: "Accès refusé" });
};

app.post("/api/appointments", checkAuth, async (req, res) => {
    const { clientName, date, time, timeEnd } = req.body;
    try {
        let current = new Date(`${date}T${time}:00`);
        const end = new Date(`${date}T${timeEnd}:00`);

        if (end <= current) return res.status(400).json({ error: "L'heure de fin doit être après le début" });

        const existingSnapshot = await db.collection("appointments").where("date", "==", date).get();
        const takenSlots = existingSnapshot.docs.map(doc => doc.data().time);
        const batch = db.batch();
        let count = 0;

        while (current < end) {
            const timeStr = current.toTimeString().substring(0, 5);
            if (!takenSlots.includes(timeStr)) {
                const docRef = db.collection("appointments").doc(); 
                batch.set(docRef, {
                    clientName: clientName || "⛔ CRÉNEAU INDISPONIBLE",
                    date, time: timeStr, email: "admin@institut.fr", phone: "0000000000",
                    reminderSent: true, isBlock: true, createdAt: new Date()
                });
                count++;
            }
            current.setMinutes(current.getMinutes() + 30);
        }
        if (count > 0) await batch.commit();
        res.json({ success: true, message: `${count} créneaux bloqués.` });
    } catch (error) { res.status(500).json({ error: "Erreur" }); }
});

// Bloquer une période entière (On ignore les Dimanches et Lundis fermés par défaut)
app.post("/api/admin/block-period", checkAuth, async (req, res) => {
    const { dateStart, dateEnd } = req.body;
    if (!dateStart || !dateEnd) return res.status(400).json({ error: "Dates manquantes" });

    try {
        const [sy, sm, sd] = dateStart.split('-').map(Number);
        const [ey, em, ed] = dateEnd.split('-').map(Number);
        const start = new Date(sy, sm - 1, sd);
        const end = new Date(ey, em - 1, ed);
        const current = new Date(start);
        let totalBlocked = 0;

        while (current <= end) {
            const day = current.getDay();
            if (day !== 0 && day !== 1) { // Pas dimanche (0), pas lundi (1)
                const dateStr = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
                const hStart = 9;
                const hEnd   = day === 6 ? 17 : 19; 

                const existingSnap = await db.collection("appointments").where("date", "==", dateStr).get();
                const takenSlots = existingSnap.docs.map(d => d.data().time);
                const batch = db.batch();
                let count = 0;

                for (let h = hStart; h < hEnd; h++) {
                    for (const m of ["00", "30"]) {
                        const timeStr = `${String(h).padStart(2,'0')}:${m}`;
                        if (!takenSlots.includes(timeStr)) {
                            const ref = db.collection("appointments").doc();
                            batch.set(ref, {
                                clientName: "⛔ INDISPONIBLE", date: dateStr, time: timeStr,
                                email: "admin@institut.fr", phone: "0000000000",
                                reminderSent: true, isBlock: true, createdAt: new Date()
                            });
                            count++;
                        }
                    }
                }
                if (count > 0) await batch.commit();
                totalBlocked += count;
            }
            current.setDate(current.getDate() + 1);
        }
        await db.collection("closed_periods").add({ dateStart, dateEnd, blockedAt: new Date() });
        res.json({ success: true, message: `${totalBlocked} créneaux d'indisponibilité générés.` });
    } catch (error) { res.status(500).json({ error: "Erreur" }); }
});

app.delete("/api/admin/unblock-day", checkAuth, async (req, res) => {
    const { date } = req.body;
    try {
        const snapshot = await db.collection("appointments").where("date", "==", date).where("isBlock", "==", true).get();
        if (snapshot.empty) return res.json({ success: true });
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        res.json({ success: true, message: "Journée rouverte." });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.post("/api/admin/open-sunday", checkAuth, async (req, res) => {
    const { date } = req.body;
    try {
        const existingSnap = await db.collection("appointments").where("date", "==", date).get();
        const batch = db.batch();
        let count = 0;
        existingSnap.docs.forEach(doc => {
            if (doc.data().isBlock) { batch.delete(doc.ref); count++; }
        });
        if (count > 0) await batch.commit();
        res.json({ success: true, message: `Journée ouverte. ${count} blocs retirés.` });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.get("/api/admin/appointments", checkAuth, async (req, res) => {
    try {
        const snapshot = await db.collection("appointments").orderBy("date", "desc").get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.get("/api/admin/blacklist", checkAuth, async (req, res) => {
    try {
        const snapshot = await db.collection("blacklist").get();
        res.json(snapshot.docs.map(doc => ({ email: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.post("/api/admin/block-email", checkAuth, async (req, res) => {
    const { email } = req.body;
    try {
        await db.collection("blacklist").doc(email).set({ blockedAt: new Date(), reason: "Manuel" });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.delete("/api/admin/block-email/:email", checkAuth, async (req, res) => {
    try {
        await db.collection("blacklist").doc(req.params.email).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.delete("/api/admin/appointment/:id", checkAuth, async (req, res) => {
    try {
        const doc = await db.collection("appointments").doc(req.params.id).get();
        if (doc.exists && doc.data().calendarEventId) {
            await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: doc.data().calendarEventId }).catch(()=>{});
        }
        await db.collection("appointments").doc(req.params.id).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.post("/api/admin/toggle-status", checkAuth, async (req, res) => {
    const { is_open } = req.body;
    await db.collection("settings").doc("status").set({ is_open });
    res.json({ success: true, is_open });
});

app.get("/api/admin/closed-periods", checkAuth, async (req, res) => {
    try {
        const snapshot = await db.collection("closed_periods").orderBy("blockedAt", "desc").get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.delete("/api/admin/closed-periods/:id", checkAuth, async (req, res) => {
    try {
        const doc = await db.collection("closed_periods").doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Introuvable" });

        const { dateStart, dateEnd } = doc.data();
        const [sy, sm, sd] = dateStart.split('-').map(Number);
        const [ey, em, ed] = dateEnd.split('-').map(Number);
        const current = new Date(sy, sm - 1, sd);
        const end = new Date(ey, em - 1, ed);

        let totalDeleted = 0;
        while (current <= end) {
            const dateStr = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
            const snap = await db.collection("appointments").where("date", "==", dateStr).where("isBlock", "==", true).get();
            if (!snap.empty) {
                const batch = db.batch();
                snap.docs.forEach(d => batch.delete(d.ref));
                await batch.commit();
                totalDeleted += snap.size;
            }
            current.setDate(current.getDate() + 1);
        }
        await db.collection("closed_periods").doc(req.params.id).delete();
        res.json({ success: true, message: `Période rouverte.` });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.post("/api/admin/open-day", checkAuth, async (req, res) => {
    try {
        await db.collection("open_days").doc(req.body.date).set({ openedAt: new Date() });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.delete("/api/admin/open-day/:date", checkAuth, async (req, res) => {
    try {
        await db.collection("open_days").doc(req.params.date).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.get("/api/status", async (req, res) => {
    try {
        const doc = await db.collection("settings").doc("status").get();
        res.json({ is_open: doc.exists ? doc.data().is_open : true });
    } catch (e) { res.json({ is_open: true }); }
});

app.get("/api/busy-slots", async (req, res) => {
    try {
        const snapshot = await db.collection("appointments").where("date", "==", req.query.date).get();
        res.json({ busySlots: snapshot.docs.map(doc => doc.data().time) });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.get("/api/open-days", async (req, res) => {
    try {
        const snapshot = await db.collection("open_days").get();
        res.json({ dates: snapshot.docs.map(doc => doc.id) });
    } catch (e) { res.json({ dates: [] }); }
});

app.get('/', (req, res) => { res.send('Serveur de Test Opérationnel !'); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur de test actif sur le port ${PORT}`);
    sendReminders();
    cleanupOldAppointments();
});