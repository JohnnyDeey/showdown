const functions = require("firebase-functions");
const admin     = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────
// HELPER: generate a 6-char alphanumeric code
// ─────────────────────────────────────────────
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─────────────────────────────────────────────
// createGameRoom
// Called by the host. Creates the Firestore game document.
// ─────────────────────────────────────────────
exports.createGameRoom = functions.https.onCall(async (data, context) => {
  const { minRange, maxRange, creatorName } = data;

  if (typeof minRange !== "number" || typeof maxRange !== "number" || minRange >= maxRange) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid range.");
  }
  if (!creatorName || typeof creatorName !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Creator name required.");
  }

  const targetNumber = parseFloat((Math.random() * (maxRange - minRange) + minRange).toFixed(2));
  const gameId       = generateRoomCode();
  const creatorId    = creatorName.toLowerCase().replace(/\s+/g, "_");

  await db.doc(`games/${gameId}`).set({
    rangeMin:          minRange,
    rangeMax:          maxRange,
    targetNumber,
    status:            "waiting",       // waiting → playing → won
    creatorId,
    playerOrder:       [creatorId],
    activePlayerIndex: 0,
    createdAt:         admin.firestore.FieldValue.serverTimestamp(),
    lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { gameId };
});

// ─────────────────────────────────────────────
// startGame
// Host calls this once enough players have joined.
// Shuffles player order and moves status to 'playing'.
// ─────────────────────────────────────────────
exports.startGame = functions.https.onCall(async (data, context) => {
  const { gameId } = data;
  const gameRef    = db.doc(`games/${gameId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "Game not found.");

    const game = snap.data();
    if (game.status !== "waiting") {
      return { success: false, message: "Game already started." };
    }

    // Grab all joined players
    const playersSnap = await db.collection(`games/${gameId}/players`).get();
    const playerIds   = playersSnap.docs.map(d => d.id);

    if (playerIds.length < 2) {
      return { success: false, message: "Need at least 2 players." };
    }

    // Shuffle
    for (let i = playerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
    }

    tx.update(gameRef, {
      status:            "playing",
      playerOrder:       playerIds,
      activePlayerIndex: 0,
      lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true };
  });
});

// ─────────────────────────────────────────────
// submitGuess
// Validates guess, narrows the range, checks win, rotates turn.
// ─────────────────────────────────────────────
exports.submitGuess = functions.https.onCall(async (data, context) => {
  const { gameId, userId, guess } = data;

  if (typeof guess !== "number") {
    throw new functions.https.HttpsError("invalid-argument", "Guess must be a number.");
  }

  const gameRef = db.doc(`games/${gameId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "Game not found.");

    const game = snap.data();
    if (game.status !== "playing") {
      return { success: false, message: "Game is not active." };
    }

    // Verify it's this player's turn
    const currentPlayerId = game.playerOrder[game.activePlayerIndex];
    if (currentPlayerId !== userId) {
      return { success: false, message: "Not your turn." };
    }

    const target     = game.targetNumber;
    const logRef     = db.collection(`games/${gameId}/guesses_public`).doc();
    const cleanName  = userId.replace(/_/g, " ");

    // ── WIN CHECK ──
    if (Math.abs(guess - target) < 0.005) {
      tx.set(logRef, {
        name:      cleanName,
        result:    `🎯 CORRECT! ${guess.toFixed(2)} is the number!`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(gameRef, {
        status:   "won",
        winnerId: userId,
        lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: true, result: "won" };
    }

    // ── NARROW RANGE ──
    let newMin = game.rangeMin;
    let newMax = game.rangeMax;
    let hint;

    if (guess < target) {
      newMin = Math.max(newMin, guess);
      hint   = `${guess.toFixed(2)} → Too Low ↑`;
    } else {
      newMax = Math.min(newMax, guess);
      hint   = `${guess.toFixed(2)} → Too High ↓`;
    }

    // ── ROTATE TURN ──
    const nextIndex = (game.activePlayerIndex + 1) % game.playerOrder.length;

    tx.set(logRef, {
      name:      cleanName,
      result:    hint,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(gameRef, {
      rangeMin:          newMin,
      rangeMax:          newMax,
      activePlayerIndex: nextIndex,
      lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, result: "continue" };
  });
});

// ─────────────────────────────────────────────
// handleTimeout
// Called by the client whose turn ran out. Removes the
// stalled player and either passes the turn, prompts solo, or closes.
// ─────────────────────────────────────────────
exports.handleTimeout = functions.https.onCall(async (data, context) => {
  const { gameId, userId } = data;
  const gameRef = db.doc(`games/${gameId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) return { success: false, message: "Game doesn't exist." };

    const game = snap.data();
    if (game.status !== "playing") return { success: false };

    let playerOrder = [...game.playerOrder];
    let activeIndex = game.activePlayerIndex;

    // Guard: only act if this is actually the stalled player's slot
    const currentPlayerId = playerOrder[activeIndex];
    if (currentPlayerId !== userId) return { success: false };

    // Remove the timed-out player
    playerOrder.splice(activeIndex, 1);

    const logRef       = db.collection(`games/${gameId}/guesses_public`).doc();
    const cleanName    = userId.replace(/_/g, " ");

    if (playerOrder.length >= 2) {
      // ── SKIP & CONTINUE ──
      const nextIndex = activeIndex % playerOrder.length;
      tx.set(logRef, {
        name:      "SYSTEM",
        result:    `⏱ ${cleanName} timed out and was removed. Passing turn…`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(gameRef, {
        playerOrder,
        activePlayerIndex: nextIndex,
        lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: true, action: "skipped" };

    } else if (playerOrder.length === 1) {
      // ── PROMPT SOLO ──
      const survivorId = playerOrder[0];
      tx.set(logRef, {
        name:      "SYSTEM",
        result:    `⏱ ${cleanName} timed out! ${survivorId.replace(/_/g, " ")} is the last player.`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(gameRef, {
        status:            "solo_decide",
        playerOrder,
        activePlayerIndex: 0,
        survivorId,
        lastActiveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: true, action: "prompt_solo" };

    } else {
      // ── EVERYONE GONE ──
      tx.delete(gameRef);
      return { success: true, action: "session_closed" };
    }
  });
});
