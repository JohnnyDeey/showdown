const functions = require("firebase-functions");
const admin     = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── createGameRoom ──
exports.createGameRoom = functions.https.onCall(async (data, context) => {
  const { minRange, maxRange, creatorName } = data;
  const min = parseFloat(minRange);
  const max = parseFloat(maxRange);

  if (isNaN(min) || isNaN(max) || min >= max) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid range.");
  }
  if (!creatorName || typeof creatorName !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Creator name required.");
  }

  const targetNumber = parseFloat((Math.random() * (max - min) + min).toFixed(2));
  const gameId       = generateRoomCode();
  const creatorId    = creatorName.toLowerCase().replace(/\s+/g, "_");

  await db.doc(`games/${gameId}`).set({
    rangeMin:            min,
    rangeMax:            max,
    targetNumber,
    status:              "waiting",
    creatorId,
    playerOrder:         [creatorId],
    activePlayerIndex:   0,
    createdAt:           admin.firestore.FieldValue.serverTimestamp(),
    lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { gameId };
});

// ── startGame ──
exports.startGame = functions.https.onCall(async (data, context) => {
  const { gameId } = data;
  const gameRef    = db.doc(`games/${gameId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "Game not found.");

    const game = snap.data();
    if (game.status !== "waiting") return { success: false, message: "Already started." };

    const playersSnap = await db.collection(`games/${gameId}/players`).get();
    const playerIds   = playersSnap.docs.map(d => d.id);

    if (playerIds.length < 1) return { success: false, message: "No players." };

    for (let i = playerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
    }

    tx.update(gameRef, {
      status:              "playing",
      playerOrder:         playerIds,
      activePlayerIndex:   0,
      lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true };
  });
});

// ── submitGuess ──
exports.submitGuess = functions.https.onCall(async (data, context) => {
  const { gameId, userId } = data;
  const guess = parseFloat(data.guess); // force number even if string sent

  if (isNaN(guess)) {
    throw new functions.https.HttpsError("invalid-argument", "Guess must be a number.");
  }
  if (!gameId || !userId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing gameId or userId.");
  }

  const gameRef = db.doc(`games/${gameId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "Game not found.");

    const game = snap.data();

    if (game.status !== "playing") {
      return { success: false, message: `Game not active (status: ${game.status}).` };
    }

    const playerOrder      = game.playerOrder || [];
    const currentPlayerId  = playerOrder[game.activePlayerIndex];

    if (currentPlayerId !== userId) {
      return { success: false, message: `Not your turn. Current: ${currentPlayerId}, You: ${userId}` };
    }

    const target    = parseFloat(game.targetNumber);
    const logRef    = db.collection(`games/${gameId}/guesses_public`).doc();
    const cleanName = userId.replace(/_/g, " ");

    // Win check
    if (Math.abs(guess - target) < 0.005) {
      tx.set(logRef, {
        name:      cleanName,
        result:    `🎯 CORRECT! ${guess.toFixed(2)} is the number!`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(gameRef, {
        status:              "won",
        winnerId:            userId,
        lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: true, result: "won" };
    }

    // Too high or too low
    let newMin    = game.rangeMin;
    let newMax    = game.rangeMax;
    let hint, direction;

    if (guess < target) {
      newMin    = Math.max(newMin, guess);
      hint      = `${guess.toFixed(2)} → Too Low ↑`;
      direction = "higher";
    } else {
      newMax    = Math.min(newMax, guess);
      hint      = `${guess.toFixed(2)} → Too High ↓`;
      direction = "lower";
    }

    const nextIndex = (game.activePlayerIndex + 1) % playerOrder.length;

    tx.set(logRef, {
      name:      cleanName,
      result:    hint,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(gameRef, {
      rangeMin:            newMin,
      rangeMax:            newMax,
      activePlayerIndex:   nextIndex,
      lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, result: direction };
  });
});

// ── handleTimeout ──
exports.handleTimeout = functions.https.onCall(async (data, context) => {
  const { gameId, userId } = data;
  const gameRef = db.doc(`games/${gameId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) return { success: false, message: "Game doesn't exist." };

    const game = snap.data();
    if (game.status !== "playing") return { success: false };

    let playerOrder = [...(game.playerOrder || [])];
    let activeIndex = game.activePlayerIndex;

    const currentPlayerId = playerOrder[activeIndex];
    if (currentPlayerId !== userId) return { success: false };

    playerOrder.splice(activeIndex, 1);

    const logRef    = db.collection(`games/${gameId}/guesses_public`).doc();
    const cleanName = userId.replace(/_/g, " ");

    if (playerOrder.length >= 2) {
      const nextIndex = activeIndex % playerOrder.length;
      tx.set(logRef, {
        name:      "SYSTEM",
        result:    `⏱ ${cleanName} timed out — passing turn…`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(gameRef, {
        playerOrder,
        activePlayerIndex:   nextIndex,
        lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: true, action: "skipped" };

    } else if (playerOrder.length === 1) {
      const survivorId = playerOrder[0];
      tx.set(logRef, {
        name:      "SYSTEM",
        result:    `⏱ ${cleanName} timed out! ${survivorId.replace(/_/g, " ")} is last standing.`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(gameRef, {
        status:              "solo_decide",
        playerOrder,
        activePlayerIndex:   0,
        survivorId,
        lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: true, action: "prompt_solo" };

    } else {
      tx.delete(gameRef);
      return { success: true, action: "session_closed" };
    }
  });
});
