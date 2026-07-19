const functions = require("firebase-functions");
const admin     = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

function generateCode(len) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

exports.createGameRoom = functions.https.onCall(async (data, context) => {
  const { minRange, maxRange, creatorName, withSpectator } = data;
  const min = parseFloat(minRange);
  const max = parseFloat(maxRange);
  if (isNaN(min) || isNaN(max) || min >= max)
    throw new functions.https.HttpsError("invalid-argument", "Invalid range.");
  if (!creatorName)
    throw new functions.https.HttpsError("invalid-argument", "Name required.");
  const targetNumber = parseFloat((Math.random()*(max-min)+min).toFixed(2));
  const gameId = generateCode(6);
  const spectatorCode = withSpectator ? generateCode(6) : null;
  const creatorId = creatorName.toLowerCase().replace(/\s+/g,"_");
  await db.doc(`games/${gameId}`).set({
    rangeMin:min, rangeMax:max, origMin:min, origMax:max,
    targetNumber, status:"waiting", creatorId,
    playerOrder:[creatorId], activePlayerIndex:0, spectatorCode,
    createdAt:admin.firestore.FieldValue.serverTimestamp(),
    lastActiveTimestamp:admin.firestore.FieldValue.serverTimestamp(),
  });
  if (spectatorCode) await db.doc(`spectators/${spectatorCode}`).set({gameId});
  return { gameId, spectatorCode };
});

exports.submitGuess = functions.https.onCall(async (data, context) => {
  const { gameId, userId } = data;
  const guess = parseFloat(data.guess);
  if (isNaN(guess)) throw new functions.https.HttpsError("invalid-argument","Guess must be a number.");
  if (!gameId||!userId) throw new functions.https.HttpsError("invalid-argument","Missing params.");
  const gameRef = db.doc(`games/${gameId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new functions.https.HttpsError("not-found","Game not found.");
    const game = snap.data();
    if (game.status !== "playing") return {success:false, message:"Not active."};
    const playerOrder = game.playerOrder || [];
    const currentPlayerId = playerOrder[game.activePlayerIndex];
    if (currentPlayerId !== userId) return {success:false, message:"Not your turn."};
    const target = parseFloat(game.targetNumber);
    const cleanName = userId.replace(/_/g," ");
    if (Math.abs(guess-target) < 0.005) {
      tx.set(db.collection(`games/${gameId}/guesses_public`).doc(),{name:cleanName,result:"correct",timestamp:admin.firestore.FieldValue.serverTimestamp()});
      tx.set(db.collection(`games/${gameId}/private_${userId}`).doc(),{guess,result:"won",timestamp:admin.firestore.FieldValue.serverTimestamp()});
      tx.update(db.doc(`games/${gameId}/players/${userId}`),{guessCount:admin.firestore.FieldValue.increment(1),lastGuess:guess});
      tx.update(gameRef,{status:"won",winnerId:userId,lastActiveTimestamp:admin.firestore.FieldValue.serverTimestamp()});
      return {success:true, result:"won"};
    }
    const direction = guess < target ? "higher" : "lower";
    const nextIndex = (game.activePlayerIndex+1) % playerOrder.length;
    tx.set(db.collection(`games/${gameId}/guesses_public`).doc(),{name:cleanName,result:direction,timestamp:admin.firestore.FieldValue.serverTimestamp()});
    tx.set(db.collection(`games/${gameId}/private_${userId}`).doc(),{guess,result:direction,timestamp:admin.firestore.FieldValue.serverTimestamp()});
    tx.update(db.doc(`games/${gameId}/players/${userId}`),{guessCount:admin.firestore.FieldValue.increment(1),lastGuess:guess});
    tx.update(gameRef,{activePlayerIndex:nextIndex,lastActiveTimestamp:admin.firestore.FieldValue.serverTimestamp()});
    return {success:true, result:direction};
  });
});

exports.handleTimeout = functions.https.onCall(async (data, context) => {
  const {gameId, userId} = data;
  const gameRef = db.doc(`games/${gameId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) return {success:false};
    const game = snap.data();
    if (game.status !== "playing") return {success:false};
    let playerOrder = [...(game.playerOrder||[])];
    const activeIndex = game.activePlayerIndex;
    if (playerOrder[activeIndex] !== userId) return {success:false};
    playerOrder.splice(activeIndex,1);
    const logRef = db.collection(`games/${gameId}/guesses_public`).doc();
    const cleanName = userId.replace(/_/g," ");
    if (playerOrder.length >= 2) {
      const nextIndex = activeIndex % playerOrder.length;
      tx.set(logRef,{name:"SYSTEM",result:"player_left",leftPlayer:cleanName,timestamp:admin.firestore.FieldValue.serverTimestamp()});
      tx.update(gameRef,{playerOrder,activePlayerIndex:nextIndex,lastActiveTimestamp:admin.firestore.FieldValue.serverTimestamp()});
      return {success:true, action:"skipped"};
    } else if (playerOrder.length === 1) {
      tx.set(logRef,{name:"SYSTEM",result:"timeout",timestamp:admin.firestore.FieldValue.serverTimestamp()});
      tx.update(gameRef,{status:"solo_decide",playerOrder,activePlayerIndex:0,survivorId:playerOrder[0],lastActiveTimestamp:admin.firestore.FieldValue.serverTimestamp()});
      return {success:true, action:"prompt_solo"};
    } else {
      tx.update(gameRef,{status:"closed",closedAt:admin.firestore.FieldValue.serverTimestamp()});
      return {success:true, action:"session_closed"};
    }
  });
});

exports.resolveSpectatorCode = functions.https.onCall(async (data, context) => {
  const {spectatorCode} = data;
  if (!spectatorCode) throw new functions.https.HttpsError("invalid-argument","Code required.");
  const snap = await db.doc(`spectators/${spectatorCode}`).get();
  if (!snap.exists) throw new functions.https.HttpsError("not-found","Not found.");
  return {gameId:snap.data().gameId};
});