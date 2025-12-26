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
const io = socketIo(server, {
  pingInterval: 25000, // Alle 25 Sekunden ein "Bist du noch da?" senden
  pingTimeout: 60000, // Erst nach 60 Sekunden ohne Antwort kicken (vorher war das viel kürzer)
  connectionStateRecovery: {
    // Versucht, den Status bei kurzem Abbruch wiederherzustellen
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

// ... (Restlicher Code Setup) ...

// --- SETUP ---
app.use(
  session({
    secret: process.env.SESSION_SECRET || "geheim",
    resave: false,
    saveUninitialized: false,
  }),
);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new TwitchStrategy(
    {
      clientID: process.env.TWITCH_CLIENT_ID,
      clientSecret: process.env.TWITCH_CLIENT_SECRET,
      callbackURL: process.env.CALLBACK_URL,
      scope: "",
    },
    (accessToken, refreshToken, profile, done) => done(null, profile),
  ),
);

function checkAdmin(req, res, next) {
  const adminName = process.env.ADMIN_USER || "schmilley";
  if (
    req.isAuthenticated() &&
    req.user.login.toLowerCase() === adminName.toLowerCase()
  ) {
    return next();
  }
  res.redirect("/");
}

app.use(express.static("public"));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);
app.get("/auth/twitch", passport.authenticate("twitch"));
app.get(
  "/auth/twitch/callback",
  passport.authenticate("twitch", { failureRedirect: "/" }),
  (req, res) => {
    const adminName = process.env.ADMIN_USER || "schmilley";
    if (req.user.login.toLowerCase() === adminName.toLowerCase())
      res.redirect("/admin");
    else
      res.redirect(
        `/player.html?username=${encodeURIComponent(req.user.display_name)}`,
      );
  },
);
app.get("/admin", checkAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "private", "admin.html")),
);
app.get("/player", (req, res) => {
  if (req.isAuthenticated())
    res.redirect(
      `/player.html?username=${encodeURIComponent(req.user.display_name)}`,
    );
  else res.sendFile(path.join(__dirname, "public", "player.html"));
});

// --- GAME LOGIK ---
let players = {};
let hostStreamId = "";
let currentQuestionInno = "";
let currentQuestionOut = "";
let currentOutsiderIds = [];

io.on("connection", (socket) => {
  socket.on("ping", () => {
    socket.emit("pong");
  });

  socket.on("join", (data) => {
    players[socket.id] = {
      id: socket.id,
      name: data.name,
      streamId: data.streamId,
      score: 0,
      image: null,
    };
    io.emit("updatePlayerList", players);
  });

  socket.on("setHostId", (id) => {
    hostStreamId = id;
    io.emit("updateHost", hostStreamId);
  });

  // --- START RUNDE (MIT IMPOSTER ANZAHL) ---
  socket.on("startRound", (data) => {
    currentQuestionInno = data.inno;
    currentQuestionOut = data.out;

    // --- DER FIX ---
    // Wir wandeln den Wert in eine Zahl um.
    let count = parseInt(data.count);

    // Nur wenn gar keine Zahl ankam (NaN), nehmen wir standardmäßig 1.
    // Wenn 0 ankommt, bleibt es jetzt 0!
    if (isNaN(count)) count = 1;
    // ----------------

    const playerIds = Object.keys(players);
    currentOutsiderIds = [];

    if (playerIds.length > 0) {
      // Mische Spieler zufällig
      const shuffled = playerIds.sort(() => 0.5 - Math.random());
      // Nimm die ersten X Spieler (Wenn count 0 ist, ist die Liste leer)
      currentOutsiderIds = shuffled.slice(0, count);
    }

    // ... (Der Rest des Blocks bleibt genau gleich wie vorher) ...

    // Reset
    playerIds.forEach((id) => {
      if (players[id]) players[id].image = null;
    });

    io.emit("resetOverlay");
    io.emit("updatePlayerList", players);

    // Aufgaben verteilen
    playerIds.forEach((id) => {
      // Prüfen ob ID im Outsider Array ist
      const isOutsider = currentOutsiderIds.includes(id);
      const task = isOutsider ? currentQuestionOut : currentQuestionInno;
      io.to(id).emit("newTask", task);
    });

    socket.emit("roundInfoUpdate", {
      questionInno: currentQuestionInno,
      questionOut: currentQuestionOut,
      outsiderIds: currentOutsiderIds,
    });
  });

  socket.on("startTimer", () => io.emit("timerStart"));
  socket.on("stopTimer", () => io.emit("timerStop"));

  socket.on("submitDrawing", (data) => {
    if (players[socket.id]) {
      players[socket.id].image = data;
      io.emit("updatePlayerList", players);
    }
  });

  // 1. Spieler stellt Frage
  socket.on("playerQuestion", (text) => {
    const p = players[socket.id];
    const name = p ? p.name : "Unbekannt";
    // Wir schicken das an ALLE Clients, aber nur das Admin-Panel hört darauf
    io.emit("incomingQuestion", { id: socket.id, name: name, text: text });
  });

  // 2. Admin antwortet
  socket.on("adminAnswer", (data) => {
    // data = { playerId: "...", text: "..." }
    // Nur an den spezifischen Spieler senden
    io.to(data.playerId).emit("hostReply", data.text);
  });

  socket.on("revealOne", (id) => {
    if (players[id] && players[id].image)
      io.emit("showOneAnswer", { id: id, image: players[id].image });
  });

  socket.on("revealQuestion", () =>
    io.emit("showQuestion", currentQuestionInno),
  );

  // --- NEU: ROLLEN AUFLÖSEN ---
  socket.on("revealRoles", () => {
    // Sendet die Liste der bösen IDs an das Overlay
    io.emit("showRoles", currentOutsiderIds);
  });

  socket.on("givePoints", (data) => {
    if (players[data.id]) {
      players[data.id].score += parseInt(data.amount);
      io.emit("updatePlayerList", players);
    }
  });

  socket.on("requestPlayerListUpdate", () =>
    socket.emit("updatePlayerList", players),
  );

  socket.on("disconnect", () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit("updatePlayerList", players);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
