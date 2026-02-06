require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const passport = require("passport");
const TwitchStrategy = require("passport-twitch-new").Strategy;
const session = require("express-session");
const path = require("path");

const app = express();
app.enable('trust proxy');

const server = http.createServer(app);

// FIX: Ping/Pong erhöhen gegen Verbindungsabbrüche
const io = socketIo(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

// --- VARIABLEN ---
let players = {};
let whitelist = []; // Hier werden erlaubte Spielernamen gespeichert
let currentQuestionInno = "";
let currentQuestionOut = "";
let imposterIds = []; // Geändert zu einer Liste (Array)

// --- AUTH SETUP ---
app.use(
  session({
    secret: process.env.SESSION_SECRET || "geheimnis",
    resave: false,
    saveUninitialized: false,
  }),
);
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new TwitchStrategy(
    {
      clientID: process.env.TWITCH_CLIENT_ID,
      clientSecret: process.env.TWITCH_CLIENT_SECRET,
      callbackURL: process.env.CALLBACK_URL,
      scope: "",
    },
    function (accessToken, refreshToken, profile, done) {
      return done(null, profile);
    },
  ),
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// --- MIDDLEWARE (TÜRSTEHER) ---

// 1. Check: Ist User Admin?
function checkAdmin(req, res, next) {
  const adminName = (process.env.ADMIN_USER || "schmilley").toLowerCase();
  if (req.isAuthenticated() && req.user.login.toLowerCase() === adminName) {
    return next();
  }
  res.redirect("/");
}

// 2. Check: Darf User mitspielen? (Whitelist)
function checkPlayerAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.redirect("/");

  const username = req.user.login.toLowerCase();
  const adminName = (process.env.ADMIN_USER || "schmilley").toLowerCase();

  // Admin darf immer rein, Whitelist-User auch
  if (username === adminName || whitelist.includes(username)) {
    return next();
  } else {
    // Nicht auf der Liste -> Rauswurf-Seite
    res.redirect("/no-access.html");
  }
}

// --- ROUTEN ---

// Statische Dateien (Public Ordner)
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// Login Start
app.get("/auth/twitch", passport.authenticate("twitch"));

// Login Rückkehr
app.get(
  "/auth/twitch/callback",
  passport.authenticate("twitch", { failureRedirect: "/" }),
  (req, res) => {
    const adminName = (process.env.ADMIN_USER || "schmilley").toLowerCase();
    // Admin zum Admin-Panel, alle anderen versuchen zum Player-Panel
    if (req.user.login.toLowerCase() === adminName) {
      res.redirect("/admin");
    } else {
      res.redirect("/player");
    }
  },
);

// Geschützte Admin Route (Datei muss in /private liegen!)
app.get("/admin", checkAdmin, (req, res) => {
  res.sendFile(__dirname + "/private/admin.html");
});

// Geschützte Player Route (Mit Whitelist Check & Profilbild-Weitergabe)
app.get("/player", checkPlayerAccess, (req, res) => {
  const username = req.user.display_name;
  // Twitch liefert das Bild in 'profile_image_url'
  const pfp = req.user.profile_image_url || "";

  // Wir geben Name UND Bild an die HTML-Datei weiter
  res.redirect(
    `/player.html?username=${encodeURIComponent(username)}&pfp=${encodeURIComponent(pfp)}`,
  );
});

// --- SOCKET.IO GAME LOGIK ---

io.on("connection", (socket) => {
  // -- WHITELIST MANAGEMENT (Nur Admin kann das triggern) --
  socket.on("admin_addWhitelist", (name) => {
    const cleanName = name.toLowerCase().trim();
    if (!whitelist.includes(cleanName)) {
      whitelist.push(cleanName);
      io.emit("updateWhitelist", whitelist); // Update an Admin zurück
    }
  });

  socket.on("admin_removeWhitelist", (name) => {
    whitelist = whitelist.filter((n) => n !== name);
    io.emit("updateWhitelist", whitelist);
    // Optional: Spieler direkt kicken, falls er online ist
    // Das ist komplexer, lassen wir erstmal weg für Stabilität
  });

  socket.on("admin_requestWhitelist", () => {
    socket.emit("updateWhitelist", whitelist);
  });

  // -- GAMEPLAY --
  socket.on("join", (data) => {
    players[socket.id] = {
      id: socket.id,
      name: data.name,
      profileImage: data.profileImage || null,
      streamId: data.streamId,
      score: 0,
      image: null,
    };
    io.emit("updatePlayerList", players);
  });

  socket.on("setHostId", (id) => io.emit("updateHost", id));

// 1. RUNDE STARTEN (Jetzt mit Anzahl!)
  socket.on("startRound", (data) => {
    currentQuestionInno = data.inno;
    currentQuestionOut = data.out;
    
    // Anzahl auslesen (Standard 1)
    const count = parseInt(data.count) || 1;

    const pIds = Object.keys(players);
    
    // RESET
    imposterIds = []; // Liste leeren
    pIds.forEach((id) => (players[id].image = null));

    // ZUFALLSWAHL (Mehrere Imposter möglich)
    if (pIds.length > 0) {
        // Spieler mischen und die ersten 'count' auswählen
        const shuffled = pIds.sort(() => 0.5 - Math.random());
        imposterIds = shuffled.slice(0, count);
    }

    io.emit("resetOverlay");
    io.emit("updatePlayerList", players);

    // AUFGABEN VERTEILEN
    pIds.forEach((id) => {
      // Prüfen ob die ID in der Imposter-Liste ist
      const isImposter = imposterIds.includes(id);
      io.to(id).emit(
        "newTask",
        isImposter ? currentQuestionOut : currentQuestionInno,
      );
    });

    // INFO AN ADMIN SENDEN (Als Liste!)
    io.emit("roundInfoUpdate", {
      questionInno: currentQuestionInno,
      questionOut: currentQuestionOut,
      imposterIds: imposterIds, 
    });
  });

  // 2. IMPOSTER AUFLÖSEN (Fehlte vorher!)
  socket.on("revealRoles", () => {
      io.emit("showRoles", imposterIds);
  });

  // 3. FRAGEN-SYSTEM (Fehlte vorher!)
  socket.on("playerQuestion", (text) => {
      const pName = players[socket.id] ? players[socket.id].name : "Unbekannt";
      // An Admin senden
      io.emit("incomingQuestion", { id: socket.id, name: pName, text: text });
  });

  socket.on("adminAnswer", (data) => {
      // Antwort an den spezifischen Spieler zurück
      io.to(data.playerId).emit("hostReply", data.text);
  });

  // ... (Hier gehts weiter mit submitDrawing wie vorher) ...
  socket.on("submitDrawing", (data) => {
    if (players[socket.id]) {
      players[socket.id].image = data;
      io.emit("updatePlayerList", players);
    }
  });

  socket.on("revealOne", (id) => {
    if (players[id] && players[id].image) {
      io.emit("showOneAnswer", { id: id, image: players[id].image });
    }
  });

  socket.on("revealQuestion", () =>
    io.emit("showQuestion", currentQuestionInno),
  );

// --- TIMER LOGIK (Das hat gefehlt!) ---
  socket.on("startTimer", () => {
    // Sagt ALLEN (also auch dem Overlay): Startet den 2-Minuten Timer!
    io.emit("timerStart"); 
  });

  socket.on("stopTimer", () => {
    // Sagt allen: Timer abbrechen!
    io.emit("timerStop");
  });
  
  socket.on("givePoints", (data) => {
    if (players[data.id]) {
      players[data.id].score += data.amount;
      io.emit("updatePlayerList", players);
    }
  });

  // -- DISCONNECT FIX (Verzögertes Löschen) --
  socket.on("disconnect", () => {
    setTimeout(() => {
      if (!io.sockets.sockets.has(socket.id)) {
        delete players[socket.id];
        io.emit("updatePlayerList", players);
      }
    }, 5000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
