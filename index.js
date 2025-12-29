require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const passport = require("passport");
const TwitchStrategy = require("passport-twitch-new").Strategy;
const session = require("express-session");
const path = require("path");

const app = express();
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
let currentOutsiderId = null;

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

  socket.on("startRound", (data) => {
    currentQuestionInno = data.inno;
    currentQuestionOut = data.out;
    const pIds = Object.keys(players);
    if (pIds.length > 0)
      currentOutsiderId = pIds[Math.floor(Math.random() * pIds.length)];

    pIds.forEach((id) => (players[id].image = null));
    io.emit("resetOverlay");
    io.emit("updatePlayerList", players);

    pIds.forEach((id) => {
      io.to(id).emit(
        "newTask",
        id === currentOutsiderId ? currentQuestionOut : currentQuestionInno,
      );
    });

    socket.emit("roundInfoUpdate", {
      questionInno: currentQuestionInno,
      questionOut: currentQuestionOut,
      outsiderId: currentOutsiderId,
    });
  });

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
