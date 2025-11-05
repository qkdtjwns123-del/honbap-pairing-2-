// firebase.js v28 — 혼밥러 공용 헬퍼 (레이스 방지 + 패널티/이용제한 + 프로필 표시용 API)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
    getAuth, onAuthStateChanged, signInAnonymously, signOut,
    signInWithEmailAndPassword, createUserWithEmailAndPassword,
    sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, updatePassword
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
    collection, query, where, orderBy, limit, getDocs, onSnapshot, runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

// 1) 구성
const __cfg = (typeof window !== "undefined" && window.firebaseConfig)
    ? window.firebaseConfig
    : {
        apiKey: "AIzaSyB0TUXQpzZIy0v2gbLOC343Jx_Lv51EQvw",
        authDomain: "honbap-paring.firebaseapp.com",
        projectId: "honbap-paring",
        storageBucket: "honbap-paring.firebasestorage.app",
        messagingSenderId: "375771626039",
        appId: "1:375771626039:web:03868631de56225cf49db2",
    };
if (!__cfg || !__cfg.apiKey) throw new Error("[firebase.js] firebaseConfig.apiKey가 비었습니다.");

const __admins = (Array.isArray(window.ADMIN_EMAILS) ? window.ADMIN_EMAILS : [])
    .map(s => String(s || "").toLowerCase());
function isAdmin() {
    const em = (auth.currentUser?.email || "").toLowerCase();
    return __admins.includes(em);
}
function isAdminEmail(emailLower) {
    return __admins.includes(String(emailLower || "").toLowerCase());
}

// 2) 초기화
const app = initializeApp(__cfg);
const auth = getAuth(app);
const db = getFirestore(app);

// 3) 공용 유틸
const my = {
    get uid() { return auth?.currentUser?.uid || null; },

    async requireAuth() {
        if (auth.currentUser) return auth.currentUser;
        const waitedUser = await new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 1500);
            const un = onAuthStateChanged(auth, (u) => {
                if (!settled && u) { settled = true; clearTimeout(timer); un(); resolve(u); }
            });
        });
        if (waitedUser) return waitedUser;
        await signInAnonymously(auth);
        return new Promise((res) => {
            const un = onAuthStateChanged(auth, (u) => { if (u) { un(); res(u); } });
        });
    },

    async logout() { await signOut(auth); },

    async nowProfile() {
        await my.requireAuth();
        const snap = await getDoc(doc(db, "profiles", my.uid));
        return snap.exists() ? snap.data() : null;
    },

    async saveProfile(p) {
        await my.requireAuth();
        const payload = {
            year: p.year ?? null,
            age: p.age ?? null,
            gender: p.gender ?? null,
            major: p.major ?? null,
            mbti: p.mbti ?? null,
            nickname: (p.nickname ?? p.nick ?? "").trim() || null,
            content: (p.content ?? p.consume ?? "").trim() || null,
            freeText: (p.freeText ?? "").trim(),
            isBot: !!p.isBot,
            // 패널티 필드는 여기서 직접 변경하지 않음
            updatedAt: serverTimestamp(),
        };
        await setDoc(doc(db, "profiles", my.uid), payload, { merge: true });
    },
};

// === 패널티/이용제한 ===
const PENALTY_LIMIT = 5;
const BAN_DURATION_MS = 60 * 60 * 1000; // 1시간

async function getPenaltyStatus() {
    await my.requireAuth();
    const p = await my.nowProfile() || {};
    const penaltyScore = Math.max(0, Number(p.penaltyScore ?? 0));
    const bannedUntil = p.bannedUntil?.toDate ? p.bannedUntil.toDate() : (p.bannedUntil instanceof Date ? p.bannedUntil : null);
    const now = Date.now();
    const remainMs = bannedUntil ? Math.max(0, bannedUntil.getTime() - now) : 0;
    return { penaltyScore, bannedUntil, remainMs };
}

async function assertNotBanned() {
    const { remainMs } = await getPenaltyStatus();
    if (remainMs > 0) {
        const mins = Math.ceil(remainMs / 60000);
        throw new Error(`이용이 제한되었습니다. 약 ${mins}분 후 다시 시도하세요.`);
    }
}

async function applyPenalty({ kind }) {
    await my.requireAuth();
    const ref = doc(db, "profiles", my.uid);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const p = snap.exists() ? snap.data() : {};
        let penaltyScore = Math.max(0, Number(p.penaltyScore ?? 0));
        let honbapTemp = Math.max(0, Number(p.honbapTemp ?? 50));

        // ✅ 패널티는 양수(누적)로 상승
        if (kind === 'early_decline' || kind === 'start_decline') penaltyScore += 1;
        if (kind === 'after_start_cancel') honbapTemp = Math.max(0, honbapTemp - 3);

        const patch = { penaltyScore, honbapTemp, updatedAt: serverTimestamp() };

        // 5회 이상이면 1시간 이용 제한
        if (penaltyScore >= PENALTY_LIMIT) {
            // 클라이언트 시각 기준 1시간 (서버타임 스탬프만으로 +1h 불가하므로 Date 사용)
            const until = new Date(Date.now() + BAN_DURATION_MS);
            patch.bannedUntil = until;
        }
        tx.set(ref, patch, { merge: true });
    });
}

// 4) 로그인/회원가입
async function loginWithEmailPassword(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
}
async function signUpWithEmailPassword(email, password) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return cred.user;
}

// 이메일 링크 가입(옵션)
const KW_EMAIL_RE = /@kw\.ac\.kr$/i;
function _assertKwEmail(email) {
    if (!email || !KW_EMAIL_RE.test(email)) throw new Error("광운대 이메일(@kw.ac.kr)만 사용 가능합니다.");
}
function _actionCodeSettings() {
    const base = (typeof window !== 'undefined' && window.location && window.location.origin)
        ? window.location.origin : "http://localhost";
    return { url: `${base}/signup.html`, handleCodeInApp: true };
}
async function sendEmailLink(email) {
    const e = (email || "").trim(); _assertKwEmail(e);
    await sendSignInLinkToEmail(auth, e, _actionCodeSettings());
    try { localStorage.setItem("signup_email", e); } catch { }
    return true;
}
async function handleEmailLinkIfPresent() {
    if (!isSignInWithEmailLink(auth, window.location.href)) return { consumed: false, email: null };
    let email = null;
    try { email = localStorage.getItem("signup_email"); } catch { }
    if (!email) throw new Error("인증을 시작한 이메일을 찾을 수 없습니다. 처음 단계에서 다시 시도해주세요.");
    const cred = await signInWithEmailLink(auth, email, window.location.href);
    return { consumed: true, email: cred.user.email || email };
}
async function setPasswordForCurrentUser(newPassword) {
    if (!auth.currentUser) throw new Error("로그인이 필요합니다.");
    if (typeof newPassword !== "string" || newPassword.length < 8) {
        throw new Error("비밀번호는 8자 이상이어야 합니다.");
    }
    await updatePassword(auth.currentUser, newPassword);
    return true;
}

// 5) 커뮤니티
async function createPost({ title, body, anonymous = false }) {
    await my.requireAuth();
    const u = auth.currentUser;

    // 표시 이름
    let authorDisplay = "익명";
    if (!anonymous) {
        const prof = await my.nowProfile().catch(() => null);
        const nick = (prof?.nickname || "").trim();
        if (nick) authorDisplay = nick;
        else if (u?.email) authorDisplay = (u.email.split("@")[0] || "익명");
    }

    await addDoc(collection(db, "posts"), {
        title: title ?? "",
        body: body ?? "",
        authorUid: u.uid,
        authorEmail: u.email ?? null,  // 권한 판정용
        authorDisplay,
        isAnonymous: !!anonymous,
        createdAt: serverTimestamp(),
    });
}

async function listPosts({ take = 30 } = {}) {
    try {
        const qy = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(take));
        const ss = await getDocs(qy);
        return ss.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error("[listPosts] 실패:", e);
        return [];
    }
}

async function updatePost(postId, { title, body }) {
    await my.requireAuth();
    if (!postId) throw new Error("postId가 필요합니다.");
    const ref = doc(db, "posts", postId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("post not found");
    const p = snap.data();
    if (!(isAdmin() || p.authorUid === my.uid)) throw new Error("권한이 없습니다.");
    const patch = {};
    if (typeof title === "string") patch.title = title;
    if (typeof body === "string") patch.body = body;
    patch.updatedAt = serverTimestamp();
    await updateDoc(ref, patch);
}

async function deletePost(postId) {
    await my.requireAuth();
    if (!postId) throw new Error("postId가 필요합니다.");
    const ref = doc(db, "posts", postId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const p = snap.data();
    if (!(isAdmin() || p.authorUid === my.uid)) throw new Error("권한이 없습니다.");
    await deleteDoc(ref);
}

function onLikeCount(postId, cb) {
    const qy = collection(db, "posts", postId, "likes");
    return onSnapshot(qy, (ss) => cb(ss.size));
}

// 6) 프레즌스
const presence = {
    tick: null,
    start() {
        if (presence.tick) return;
        presence.tick = setInterval(async () => {
            try {
                await my.requireAuth();
                await setDoc(doc(db, "presence", my.uid), { lastActive: serverTimestamp() }, { merge: true });
            } catch { }
        }, 15000);
    },
    stop() { if (presence.tick) clearInterval(presence.tick); presence.tick = null; }
};
presence.start();

// 7~9) 매칭/채팅/테스트봇
const MATCH_TIMEOUT_MS = 45000;
const ONLINE_WINDOW_MS = 90000;

async function leaveQueueByUid(uid) {
    const qy = query(collection(db, "matchQueue"), where("uid", "==", uid));
    const ss = await getDocs(qy);
    await Promise.all(ss.docs.map(d => deleteDoc(d.ref)));
}
async function enterQueue(options) {
    await my.requireAuth();
    const prof = await my.nowProfile() || {};
    const ref = doc(collection(db, "matchQueue"));
    const payload = {
        uid: my.uid,
        email: auth.currentUser.email ?? null,
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp(),
        status: "waiting",
        pref: {
            year: prof.year ?? null,
            age: prof.age ?? null,
            gender: prof.gender ?? null,
            major: prof.major ?? null,
            freeText: prof.freeText ?? "",
            ...options,
        },
        isBot: !!prof.isBot,
        roomId: null,
    };
    await setDoc(ref, payload);
    return ref.id;
}
async function findOpponent(myDocId) {
    const myRef = doc(db, "matchQueue", myDocId);
    const myDoc = await getDoc(myRef);
    if (!myDoc.exists()) throw new Error("대기열 문서가 없어요.");
    const me = myDoc.data();

    const snaps = await getDocs(
        query(collection(db, "matchQueue"),
            where("status", "==", "waiting"),
            orderBy("createdAt", "asc"), limit(25))
    );

    const now = Date.now();
    const freeOverlapCheck = (A, B) => {
        if (!me.pref?.freeOverlap) return true;
        const pick = s => (s || "").replace(/\s/g, "");
        const a = pick(me.pref?.freeText);
        const b = pick(B?.pref?.freeText);
        if (!a || !b) return false;
        return ['월', '화', '수', '목', '금', '토', '일'].some(ch => a.includes(ch) && b.includes(ch));
    };

    for (const d of snaps.docs) {
        if (d.id === myDocId) continue;
        const you = d.data();
        if (you.uid === me.uid) continue;
        if (you.status !== 'waiting') continue;

        if (me.pref?.onlineOnly) {
            const last = (you.lastActive?.toDate?.() || new Date(0)).getTime();
            if (now - last > ONLINE_WINDOW_MS) continue;
        }
        const same = (a, b) => (a != null && b != null && a === b);
        if (me.pref?.yearSame && !same(me.pref?.year, you.pref?.year)) continue;
        if (me.pref?.majorSame && !same(me.pref?.major, you.pref?.major)) continue;
        if (me.pref?.ageSame && !same(me.pref?.age, you.pref?.age)) continue;
        if (me.pref?.genderSame && !same(me.pref?.gender, you.pref?.gender)) continue;
        if (!freeOverlapCheck(me.pref?.freeText, you)) continue;

        return { id: d.id, you };
    }
    return null;
}
async function createRoomAndInvite(myDocId, oppDocId) {
    // 상대 UID를 조회해 expectedMembers에 두 사람을 고정
    const oppSnap = await getDoc(doc(db, "matchQueue", oppDocId));
    const opp = oppSnap.exists() ? oppSnap.data() : null;
    const oppUid = opp?.uid || null;

    const roomRef = doc(collection(db, "rooms"));
    const expected = oppUid ? Array.from(new Set([my.uid, oppUid])) : [my.uid];

    const room = {
        members: [my.uid],                     // 실제 참여 반영(점진적)
        expectedMembers: expected,             // ✅ 최종 투표 집계 대상(2명 고정)
        createdAt: serverTimestamp(),
        phase: "pendingAccept",
        invites: { to: oppDocId, at: serverTimestamp(), accepted: null },
    };
    await setDoc(roomRef, room);
    await updateDoc(doc(db, "matchQueue", myDocId), { status: "matched", roomId: roomRef.id, lastActive: serverTimestamp() });
    await updateDoc(doc(db, "matchQueue", oppDocId), { status: "matched", roomId: roomRef.id, lastActive: serverTimestamp() });
    return roomRef;
}
async function waitInviteDecision(roomId, timeoutSec = 30) {
    const ref = doc(db, "rooms", roomId);
    return new Promise((resolve) => {
        const t = setTimeout(() => { un(); resolve(false); }, timeoutSec * 1000);
        const un = onSnapshot(ref, (snap) => {
            if (!snap.exists()) return;
            const r = snap.data();
            if (r.phase === 'startCheck') { clearTimeout(t); un(); resolve(true); }
            if (r.phase === 'declined') { clearTimeout(t); un(); resolve(false); }
        });
    });
}
async function myAcceptOrDecline(roomId, accept) {
    const ref = doc(db, "rooms", roomId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("room not found");
        const r = snap.data();

        // 현재/예상 멤버 집합
        const members = new Set(r.members || []);
        members.add(my.uid);
        const expected = new Set((r.expectedMembers || r.members || []).filter(Boolean));

        // 거절이면 즉시 종료
        if (!accept) {
            tx.update(ref, {
                members: Array.from(members),
                phase: 'declined',
                updatedAt: serverTimestamp(),
            });
            return;
        }

        // 수락이면 멤버 반영 후, 두 사람 모두 멤버에 들어온 경우에만 startCheck로 전환
        const allJoined = Array.from(expected).every(u => members.has(u));
        tx.update(ref, {
            members: Array.from(members),
            phase: allJoined ? 'startCheck' : 'pendingAccept',
            updatedAt: serverTimestamp(),
        });
    });
}
async function waitStartDecision(roomId, timeoutSec = 30) {
    const ref = doc(db, "rooms", roomId);
    return new Promise((resolve) => {
        const t = setTimeout(() => { un(); resolve(false); }, timeoutSec * 1000);
        const un = onSnapshot(ref, (snap) => {
            if (!snap.exists()) return;
            const r = snap.data();
            if (r.phase === 'chatting') { clearTimeout(t); un(); resolve(true); }
            if (r.phase === 'startDeclined') { clearTimeout(t); un(); resolve(false); }
        });
    });
}
async function myStartYesOrNo(roomId, yes) {
    const ref = doc(db, "rooms", roomId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("room not found");
        const r = snap.data();
        if (r.phase !== 'startCheck') return;

        const expected = new Set((r.expectedMembers || r.members || []).filter(Boolean));
        const voted = new Set(r.startVoted || []);
        const yesSet = new Set(r.startYes || []);

        voted.add(my.uid);
        if (yes) yesSet.add(my.uid);

        const everyoneVoted = Array.from(expected).every(u => voted.has(u));
        const everyoneYes = everyoneVoted && Array.from(expected).every(u => yesSet.has(u));

        tx.update(ref, {
            startVoted: Array.from(voted),
            startYes: Array.from(yesSet),
            phase: everyoneVoted ? (everyoneYes ? 'chatting' : 'startDeclined') : 'startCheck',
            updatedAt: serverTimestamp(),
        });
    });
}
function gotoRoom(roomId) { location.href = `chat.html?room=${encodeURIComponent(roomId)}`; }

async function cancelMatching() {
    if (!auth.currentUser) return;
    await leaveQueueByUid(my.uid);
}
async function markLeaving() {
    if (!auth.currentUser) return;
    const qy = query(collection(db, "matchQueue"), where("uid", "==", my.uid), limit(1));
    const ss = await getDocs(qy);
    if (ss.empty) return;
    await updateDoc(ss.docs[0].ref, { status: "leaving", lastActive: serverTimestamp() });
}

async function assertRoomMember(roomId) {
    await my.requireAuth();
    const snap = await getDoc(doc(db, "rooms", roomId));
    if (!snap.exists()) throw new Error("room not found");
    const room = snap.data();
    const target = new Set((room.expectedMembers || room.members || []).filter(Boolean));
    if (!target.has(my.uid)) {
        throw new Error("you are not a member of this room");
    }
    return true;
}
function onMessages(roomId, cb) {
    const qy = query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "asc"), limit(200));
    return onSnapshot(qy, (ss) => { cb(ss.docs.map(d => ({ id: d.id, ...d.data() }))); });
}
async function sendMessage(roomId, text) {
    await my.requireAuth();
    const t = (text || "").trim();
    if (!t) return;
    await addDoc(collection(db, "rooms", roomId, "messages"), {
        text: t, uid: my.uid, email: auth.currentUser?.email ?? null, createdAt: serverTimestamp(),
    });
}
async function leaveRoom(roomId) {
    await my.requireAuth();
    const ref = doc(db, "rooms", roomId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const r = snap.data();
        const members = (r.members || []).filter(u => u !== my.uid);
        const update = { members, updatedAt: serverTimestamp() };
        if (members.length === 0) update.phase = 'ended';
        tx.update(ref, update);
    });
    await leaveQueueByUid(my.uid);
}

// 10) 전역 API
const api = {
    auth, db,
    requireAuth: my.requireAuth,
    logout: my.logout,

    loginWithEmailPassword, signUpWithEmailPassword,
    sendEmailLink, handleEmailLinkIfPresent, setPasswordForCurrentUser,

    loadProfile: my.nowProfile, saveProfile: my.saveProfile,

    createPost, listPosts, updatePost, deletePost, onLikeCount,

    // ✅ 매칭 시작 전 이용제한 확인
    startMatching: async (options) => {
        await my.requireAuth();
        await assertNotBanned();                 // ⬅️ 이용 제한 시 시작 차단
        await leaveQueueByUid(my.uid);
        const myDocId = await enterQueue(options);
        const found = await findOpponent(myDocId);
        if (!found) {
            const myRef = doc(db, "matchQueue", myDocId);
            const room = await new Promise((resolve, reject) => {
                const t = setTimeout(() => { un(); reject(new Error("제한 시간 내에 상대를 못 찾았어요.")); }, MATCH_TIMEOUT_MS);
                const un = onSnapshot(myRef, async (snap) => {
                    if (!snap.exists()) return;
                    const d = snap.data();
                    if (d.status === 'matched' && d.roomId) { clearTimeout(t); un(); resolve({ id: d.roomId }); }
                    else updateDoc(myRef, { lastActive: serverTimestamp() }).catch(() => { });
                });
            });
            return room;
        }
        const roomRef = await createRoomAndInvite(myDocId, found.id);
        return { id: roomRef.id };
    },
    readyToAccept: waitInviteDecision,
    acceptMatch: (roomId) => myAcceptOrDecline(roomId, true),
    declineMatch: (roomId) => myAcceptOrDecline(roomId, false),
    readyToChat: waitStartDecision,
    startYes: (roomId) => myStartYesOrNo(roomId, true),
    startNo: (roomId) => myStartYesOrNo(roomId, false),
    gotoRoom,

    applyPenalty, cancelMatching, markLeaving,

    onMessages, sendMessage, assertRoomMember, leaveRoom,

    // ✅ 테스트봇도 이용제한 확인
    startWithTestBot: async () => {
        await my.requireAuth();
        await assertNotBanned();                 // ⬅️ 이용 제한 시 시작 차단
        await leaveQueueByUid(my.uid);
        const roomRef = doc(collection(db, "rooms"));
        await setDoc(roomRef, { members: [my.uid, "__testbot__"], expectedMembers: [my.uid, "__testbot__"], createdAt: serverTimestamp(), phase: "chatting" });
        await addDoc(collection(db, "rooms", roomRef.id, "messages"), {
            text: "테스트봇 연결 완료 ✅ 채팅 입력 테스트 해보세요.",
            uid: "__testbot__", email: "bot", createdAt: serverTimestamp()
        });
        return { id: roomRef.id };
    },

    // ✅ 페이지에서 관리자/패널티/제한 상태 확인용
    isAdminEmail,
    getPenaltyStatus,
};

window.fb = api;
window.fbReady = Promise.resolve(api);
window.getFb = async () => window.fbReady;
