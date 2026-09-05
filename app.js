import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, setDoc, deleteDoc, updateDoc,
  onSnapshot, query, orderBy,
  getAggregateFromServer, average, count
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);

const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const $ = (id) => document.getElementById(id);

let currentUser  = null;
let unsubscribe  = null;
let mode         = "login";
let listeCache   = [];
let ficheCourante = null;     // anime affiché dans la fiche
let filtreStatut = "tous";
let categorieActive = 0;

/* ══════════════════ AniList ══════════════════

   L'API accepte les appels depuis un navigateur, ne demande aucune clé, et
   possède sa propre base — contrairement aux passerelles qui relaient
   MyAnimeList et tombent avec lui.
   ═════════════════════════════════════════════ */

const ANILIST = "https://graphql.anilist.co";

const CHAMPS = `
  id
  title { romaji english }
  coverImage { large }
  description(asHtml: false)
  episodes
  format
  status
  season
  seasonYear
  genres
  popularity
  favourites
  startDate { year month day }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  studios(isMain: true) { nodes { name } }
`;

async function anilist(query, variables = {}) {
  const res = await fetch(ANILIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`AniList a répondu ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

const normaliser = (m) => ({
  id:        String(m.id),
  title:     m.title?.english || m.title?.romaji || "Sans titre",
  cover:     m.coverImage?.large || "",
  resume:    (m.description || "").replace(/<[^>]+>/g, "").trim(),
  episodes:  m.episodes || 0,
  format:    m.format || "",
  statutDiff:m.status || "",
  saison:    m.season || "",
  annee:     m.seasonYear || m.startDate?.year || null,
  genres:    m.genres || [],
  hype:      m.popularity || 0,
  favoris:   m.favourites || 0,
  debut:     m.startDate || null,
  prochain:  m.nextAiringEpisode || null,
  studio:    m.studios?.nodes?.[0]?.name || ""
});

/* Les genres et les étiquettes sont deux systèmes distincts chez AniList.
   Isekai, School ou Time Loop sont des étiquettes, pas des genres : les
   demander comme genre ne renvoie rien du tout. D'où les deux champs. */
const CATEGORIES = [
  { nom: "Isekai",        tag: "Isekai" },
  { nom: "Romance",       genre: "Romance" },
  { nom: "Comédie",       genre: "Comedy" },
  { nom: "Tranche de vie", genre: "Slice of Life" },
  { nom: "Action",        genre: "Action" },
  { nom: "Aventure",      genre: "Adventure" },
  { nom: "Fantastique",   genre: "Fantasy" },
  { nom: "Drame",         genre: "Drama" },
  { nom: "Sport",         genre: "Sports" },
  { nom: "Psychologique", genre: "Psychological" },
  { nom: "Mecha",         genre: "Mecha" },
  { nom: "Horreur",       genre: "Horror" },
  { nom: "Mystère",       genre: "Mystery" },
  { nom: "Surnaturel",    genre: "Supernatural" },
  { nom: "Scolaire",      tag: "School" },
  { nom: "Boucle temporelle", tag: "Time Manipulation" }
];

async function aVenir() {
  const d = await anilist(
    `query { Page(perPage: 30) { media(
       type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC, isAdult: false
     ) { ${CHAMPS} } } }`);
  return d.Page.media.map(normaliser);
}

async function parCategorie(cat) {
  const d = await anilist(
    `query ($genre: String, $tag: String) { Page(perPage: 30) { media(
       type: ANIME, genre: $genre, tag: $tag, sort: POPULARITY_DESC, isAdult: false
     ) { ${CHAMPS} } } }`,
    { genre: cat.genre || null, tag: cat.tag || null });
  return d.Page.media.map(normaliser);
}

async function chercher(terme) {
  const d = await anilist(
    `query ($q: String) { Page(perPage: 20) { media(
       type: ANIME, search: $q, isAdult: false
     ) { ${CHAMPS} } } }`, { q: terme });
  return d.Page.media.map(normaliser);
}

async function parIdentifiant(id) {
  const d = await anilist(
    `query ($id: Int) { Media(id: $id, type: ANIME) { ${CHAMPS} } }`,
    { id: Number(id) });
  return normaliser(d.Media);
}

/* ══════════════════ Mise en forme ══════════════════ */

const MOIS = ["janvier","février","mars","avril","mai","juin",
              "juillet","août","septembre","octobre","novembre","décembre"];

const SAISONS = { WINTER: "hiver", SPRING: "printemps", SUMMER: "été", FALL: "automne" };

const FORMATS = {
  TV: "Série TV", TV_SHORT: "Format court", MOVIE: "Film",
  SPECIAL: "Spécial", OVA: "OVA", ONA: "ONA", MUSIC: "Clip"
};

function dateDebut(a) {
  const d = a.debut;
  if (d?.year && d?.month && d?.day) return `${d.day} ${MOIS[d.month - 1]} ${d.year}`;
  if (d?.year && d?.month) return `${MOIS[d.month - 1]} ${d.year}`;
  if (a.saison && a.annee) return `${SAISONS[a.saison] || ""} ${a.annee}`.trim();
  if (d?.year) return String(d.year);
  return "date inconnue";
}

/* Un compte à rebours parle davantage qu'une date : « dans 3 jours » se
   comprend d'un coup d'œil, « 14 mars » demande un calcul. */
function compteARebours(secondes) {
  const j = Math.floor(secondes / 86400);
  const h = Math.floor((secondes % 86400) / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  if (j > 0)  return `dans ${j} jour${j > 1 ? "s" : ""}${h ? ` et ${h} h` : ""}`;
  if (h > 0)  return `dans ${h} h ${m} min`;
  return `dans ${m} min`;
}

const nombreCourt = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",")} k` : String(n);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ══════════════════ Authentification ══════════════════ */

/* Le site est consultable sans compte : « À venir », « Découvrir » et les
   fiches fonctionnent pour tout le monde. Un compte n'ouvre que le suivi
   personnel et la notation. L'application reste donc toujours affichée, et
   c'est l'état de connexion qui pilote les fonctions disponibles. */
onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  $("app-screen").hidden = false;
  chargerAVenir();
  construireCategories();

  const connecte = !!user;
  $("user-email").hidden       = !connecte;
  $("logout").hidden           = !connecte;
  $("ouvrir-connexion").hidden = connecte;
  $("liste-invite").hidden     = connecte;
  $("liste-contenu").hidden    = !connecte;

  if (!connecte) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    listeCache = [];
    notesCache.clear();          // les notes personnelles ne valent plus
    if (ficheCourante) majFiche();
    rafraichirCartes();
    return;
  }

  fermerConnexion();
  $("user-email").textContent = user.displayName || user.email;
  suivreListe(user.uid);

  try {
    const profil = await getDoc(doc(db, "users", user.uid));
    if (profil.exists() && profil.data().pseudo) {
      $("user-email").textContent = profil.data().pseudo;
    }
  } catch { /* le profil n'est pas indispensable à l'affichage */ }
});

/* ══════════════════ Fenêtre de connexion ══════════════════ */

function ouvrirConnexion(motif) {
    showReset(false);
  if (motif) toast(motif);
  setTimeout(() => $("email").focus(), 100);
}

function fermerConnexion() {
  $("auth-screen").hidden = true;
  hideError();
}

$("ouvrir-connexion").addEventListener("click", () => ouvrirConnexion());
$("invite-connexion").addEventListener("click", () => ouvrirConnexion());
$("auth-fermer").addEventListener("click", fermerConnexion);

// Clic sur le fond, ou touche Échap : deux façons attendues de refermer.
$("auth-screen").addEventListener("click", (e) => {
  if (e.target === $("auth-screen")) fermerConnexion();
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("auth-screen").hidden) fermerConnexion();
});

$("auth-toggle").addEventListener("click", () => {
  mode = mode === "login" ? "signup" : "login";
  const signup = mode === "signup";
  $("auth-submit").textContent      = signup ? "Créer mon compte" : "Se connecter";
  $("auth-switch-text").textContent = signup ? "Tu as déjà un compte ?" : "Pas encore de compte ?";
  $("auth-toggle").textContent      = signup ? "Se connecter" : "Créer un compte";
  $("password").autocomplete        = signup ? "new-password" : "current-password";
  $("auth-forgot-wrap").hidden      = signup;
  $("pseudo-field").hidden          = !signup;
  $("pseudo").required              = signup;
  hideError();
});

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();

  const email = $("email").value.trim();
  const pass  = $("password").value;

  if (!email || pass.length < 6) {
    return showError("Il faut une adresse valide et un mot de passe d'au moins 6 caractères.");
  }

  $("auth-submit").disabled = true;
  try {
    if (mode === "signup") await creerCompte(email, pass);
    else await signInWithEmailAndPassword(auth, email, pass);
    $("auth-form").reset();
  } catch (err) {
    if (err.message === "pseudo-invalide") {
      showError("Le pseudo doit faire 3 à 20 caractères, sans espace ni accent.");
    } else if (err.message === "pseudo-pris") {
      showError("Ce pseudo est déjà utilisé. Choisis-en un autre.");
    } else {
      console.error("Firebase Auth :", err.code, err.message, err);
      showError(authMessage(err.code));
    }
  } finally {
    $("auth-submit").disabled = false;
  }
});

/* Le pseudo est réservé dans une collection dédiée : l'identifiant du document
   étant le pseudo en minuscules, Firestore garantit son unicité. */
async function creerCompte(email, pass) {
  const pseudo = $("pseudo").value.trim();
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(pseudo)) throw new Error("pseudo-invalide");

  const cle = pseudo.toLowerCase();
  if ((await getDoc(doc(db, "usernames", cle))).exists()) throw new Error("pseudo-pris");

  const { user } = await createUserWithEmailAndPassword(auth, email, pass);

  try {
    await setDoc(doc(db, "usernames", cle), { uid: user.uid });
    await setDoc(doc(db, "users", user.uid), { pseudo, createdAt: Date.now() });
    await updateProfile(user, { displayName: pseudo });
    $("user-email").textContent = pseudo;
  } catch (err) {
    console.error("Enregistrement du pseudo :", err.code, err.message);
    toast("Compte créé, mais le pseudo n'a pas pu être enregistré.");
  }
}

$("logout").addEventListener("click", () => signOut(auth));

function authMessage(code) {
  const messages = {
    "auth/email-already-in-use": "Cette adresse a déjà un compte. Connecte-toi.",
    "auth/invalid-email":        "Cette adresse e-mail n'est pas valide.",
    "auth/weak-password":        "Le mot de passe doit faire au moins 6 caractères.",
    "auth/invalid-credential":   "Adresse ou mot de passe incorrect — ou aucun compte pour cette adresse.",
    "auth/too-many-requests":    "Trop de tentatives. Réessaie dans quelques minutes.",
    "auth/network-request-failed": "Connexion au serveur impossible.",
    "auth/operation-not-allowed": "Active le fournisseur E-mail/Mot de passe dans la console Firebase.",
    "auth/unauthorized-domain":  "Ce domaine n'est pas autorisé dans Authentication → Settings."
  };
  return messages[code] || `Échec de l'opération. Code renvoyé : ${code || "inconnu"}`;
}

const showError = (msg) => {
  const el = $("auth-error");
  el.textContent = msg; el.classList.remove("is-note"); el.hidden = false;
};
const hideError = () => {
  const el = $("auth-error"); el.hidden = true; el.classList.remove("is-note");
};

/* ══════════════════ Mot de passe oublié ══════════════════ */

$("auth-forgot").addEventListener("click", () => showReset(true));
$("reset-back").addEventListener("click", () => showReset(false));

function showReset(on) {
  $("login-view").hidden = on;
  $("reset-view").hidden = !on;
  hideError(); hideResetError();
  if (on) { $("reset-form").reset(); $("reset-email").focus(); }
}

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideResetError();
  const email = $("reset-email").value.trim();
  if (!email) { $("reset-email").focus(); return showResetError("Saisis l'adresse de ton compte."); }

  $("reset-submit").disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    confirmSent();
  } catch (err) {
    // On ne révèle pas si l'adresse a un compte : même message dans les deux cas.
    if (err.code === "auth/user-not-found") confirmSent();
    else showResetError(authMessage(err.code));
  } finally {
    $("reset-submit").disabled = false;
  }
});

function confirmSent() {
  showResetError("Si un compte existe pour cette adresse, un lien vient d'y être envoyé. Regarde aussi dans les indésirables.");
  $("reset-error").classList.add("is-note");
  $("reset-form").reset();
}

const showResetError = (msg) => {
  const el = $("reset-error");
  el.textContent = msg; el.classList.remove("is-note"); el.hidden = false;
};
const hideResetError = () => {
  const el = $("reset-error"); el.hidden = true; el.classList.remove("is-note");
};

/* ══════════════════ Navigation ══════════════════ */

document.querySelectorAll("[data-vue]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.vue));
});

$("fiche-retour").addEventListener("click", () => showView(vuePrecedente));

let vuePrecedente = "avenir";

function showView(nom) {
  if (nom !== "fiche") vuePrecedente = nom;

  $("view-avenir").hidden    = nom !== "avenir";
  $("view-decouvrir").hidden = nom !== "decouvrir";
  $("view-liste").hidden     = nom !== "liste";
  $("view-fiche").hidden     = nom !== "fiche";

  // La fiche n'a pas d'onglet : on garde en surbrillance celui d'où l'on vient.
  const onglet = nom === "fiche" ? vuePrecedente : nom;

  document.querySelectorAll("[data-vue]").forEach((btn) => {
    const actif = btn.dataset.vue === onglet;
    btn.classList.toggle("is-active", actif);
    btn.setAttribute("aria-current", actif ? "page" : "false");
  });

  const rang = ["avenir", "decouvrir", "liste"].indexOf(onglet);
  document.querySelector(".barre-basse")?.style.setProperty("--onglet", rang);

  if (nom !== "fiche") ficheCourante = null;
  window.scrollTo(0, 0);
}

/* ══════════════════ À venir ══════════════════ */

let avenirCharge = false;

async function chargerAVenir() {
  if (avenirCharge) return;
  avenirCharge = true;

  const grille = $("avenir-liste");
  grille.innerHTML = `<p class="loading">Chargement…</p>`;

  try {
    const animes = await aVenir();
    grille.innerHTML = "";
    animes.forEach((a) => grille.appendChild(carte(a, "avenir")));
  } catch (err) {
    avenirCharge = false;
    console.error("À venir :", err);
    grille.innerHTML = `<p class="loading">Indisponible pour le moment (${escapeHtml(err.message)}).</p>`;
  }
}

/* ══════════════════ Découvrir ══════════════════ */

function construireCategories() {
  const zone = $("categories");
  if (zone.children.length) return;

  CATEGORIES.forEach((cat, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `categorie ${i === 0 ? "is-active" : ""}`;
    btn.textContent = cat.nom;
    btn.addEventListener("click", () => {
      categorieActive = i;
      zone.querySelectorAll(".categorie").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      chargerCategorie();
    });
    zone.appendChild(btn);
  });

  chargerCategorie();
}

async function chargerCategorie() {
  const cat = CATEGORIES[categorieActive];
  const grille = $("categorie-liste");

  $("categorie-note").textContent = cat.tag
    ? `« ${cat.nom} » est une étiquette AniList, plus fine qu'un genre.`
    : `Genre « ${cat.nom} », classé par popularité.`;

  grille.innerHTML = `<p class="loading">Chargement…</p>`;

  try {
    const animes = await parCategorie(cat);
    grille.innerHTML = "";
    if (!animes.length) {
      grille.innerHTML = `<p class="loading">Aucun résultat pour cette catégorie.</p>`;
      return;
    }
    animes.forEach((a) => grille.appendChild(carte(a, "populaire")));
  } catch (err) {
    console.error("Catégorie :", err);
    grille.innerHTML = `<p class="loading">Indisponible (${escapeHtml(err.message)}).</p>`;
  }
}

/* ══════════════════ Recherche ══════════════════ */

let minuteur = null, jeton = 0;

$("search-input").addEventListener("input", () => {
  const terme = $("search-input").value.trim();
  clearTimeout(minuteur);

  if (terme.length < 2) {
    jeton++;
    $("search-results").hidden = true;
    $("search-input").classList.remove("is-searching");
    return;
  }

  $("search-input").classList.add("is-searching");
  minuteur = setTimeout(() => lancerRecherche(terme), 350);
});

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(minuteur);
  const terme = $("search-input").value.trim();
  if (terme) lancerRecherche(terme);
});

async function lancerRecherche(terme) {
  const mien = ++jeton;
  const box = $("search-results");
  box.hidden = false;

  try {
    const animes = await chercher(terme);
    if (mien !== jeton) return;   // une frappe plus récente a pris le relais

    box.innerHTML = `<h2 class="section-title">Résultats</h2>`;
    if (!animes.length) {
      box.innerHTML += `<p class="section-note">Rien pour « ${escapeHtml(terme)} ».</p>`;
      return;
    }
    const grille = document.createElement("div");
    grille.className = "grille";
    animes.forEach((a) => grille.appendChild(carte(a, "populaire")));
    box.appendChild(grille);
  } catch (err) {
    if (mien !== jeton) return;
    box.innerHTML = `<p class="section-note">Recherche impossible : ${escapeHtml(err.message)}.</p>`;
  } finally {
    if (mien === jeton) $("search-input").classList.remove("is-searching");
  }
}

/* ══════════════════ Cartes ══════════════════ */

function carte(a, genre) {
  const suivi = listeCache.find((s) => s.id === a.id);

  let bandeau = "";
  if (genre === "avenir") {
    bandeau = a.prochain
      ? `Épisode 1 ${compteARebours(a.prochain.timeUntilAiring)}`
      : dateDebut(a);
  } else if (suivi) {
    bandeau = `${suivi.vus} / ${suivi.episodes || "?"} épisodes`;
  }

  const el = document.createElement("button");
  el.type = "button";
  el.className = "carte";
  el.dataset.anime = a.id;
  el.innerHTML = `
    <span class="carte-img">
      <img src="${a.cover}" alt="" loading="lazy" referrerpolicy="no-referrer">
      ${genre === "avenir" ? `<span class="carte-hype">${nombreCourt(a.hype)} en attente</span>` : ""}
      ${suivi ? `<span class="carte-suivi">Suivi</span>` : ""}
      ${bandeau ? `<span class="carte-bandeau">${escapeHtml(bandeau)}</span>` : ""}
    </span>
    <span class="carte-nom">${escapeHtml(a.title)}</span>
    <span class="carte-meta">${escapeHtml(FORMATS[a.format] || a.format)}${a.annee ? ` · ${a.annee}` : ""}</span>
    <span class="carte-note"></span>`;

  el.addEventListener("click", () => ouvrirFiche(a));
  observateurNotes.observe(el);
  return el;
}

/* Les moyennes ne sont demandées que pour les cartes qui entrent à l'écran :
   interroger d'un coup trente titres ferait autant de requêtes pour des
   séries que personne ne regardera. */
const observateurNotes = new IntersectionObserver((entrees) => {
  entrees.forEach((e) => {
    if (!e.isIntersecting) return;
    observateurNotes.unobserve(e.target);
    chargerNote(e.target.dataset.anime)
      .then((n) => {
        const cible = e.target.querySelector(".carte-note");
        if (cible && n.moyenne !== null) cible.textContent = texteNote(n);
      })
      .catch(() => { /* une moyenne absente ne casse pas la grille */ });
  });
}, { rootMargin: "300px" });

/* ══════════════════ Ma liste ══════════════════ */

function suivreListe(uid) {
  $("loading").hidden = false;
  const q = query(collection(db, "users", uid, "animes"), orderBy("addedAt", "asc"));

  unsubscribe = onSnapshot(q, (snap) => {
    $("loading").hidden = true;
    listeCache = snap.docs.map((d) => d.data());
    afficherListe();
    if (ficheCourante) majFiche();
    rafraichirCartes();
  }, (err) => {
    console.error("Firestore :", err.code, err.message);
    $("loading").textContent = "Impossible de lire ta liste. Vérifie les règles Firestore.";
  });
}

document.querySelectorAll(".filtre").forEach((btn) => {
  btn.addEventListener("click", () => {
    filtreStatut = btn.dataset.statut;
    document.querySelectorAll(".filtre").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    afficherListe();
  });
});

const estTermine = (s) => s.episodes > 0 && s.vus >= s.episodes;

function afficherListe() {
  const grille = $("liste");
  grille.innerHTML = "";

  $("stats").hidden = listeCache.length === 0;

  const episodes = listeCache.reduce((n, s) => n + s.vus, 0);
  const termines = listeCache.filter(estTermine).length;

  $("stat-suivis").textContent   = listeCache.length;
  $("stat-episodes").textContent = episodes;
  $("stat-termines").textContent = termines;

  /* Les séries en cours d'abord : c'est ce qu'on vient consulter. Ensuite
     l'ordre alphabétique, avec les règles françaises pour les accents. */
  const rang = (s) => (s.statut === "en_cours" ? 0 : s.statut === "a_voir" ? 1 : 2);
  const visibles = listeCache
    .filter((s) => filtreStatut === "tous" || s.statut === filtreStatut)
    .sort((a, b) => rang(a) - rang(b)
      || a.title.localeCompare(b.title, "fr", { sensitivity: "base", numeric: true }));

  $("liste-vide").hidden = listeCache.length > 0;

  visibles.forEach((s) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "carte";
    el.dataset.anime = s.id;

    const pct = s.episodes ? Math.round((s.vus / s.episodes) * 100) : 0;
    el.innerHTML = `
      <span class="carte-img">
        <img src="${s.cover}" alt="" loading="lazy" referrerpolicy="no-referrer">
        ${estTermine(s) ? `<span class="carte-suivi">Terminé</span>` : ""}
        <span class="carte-bandeau">${s.vus} / ${s.episodes || "?"} épisodes${s.episodes ? ` · ${pct} %` : ""}</span>
      </span>
      <span class="carte-nom">${escapeHtml(s.title)}</span>
      <span class="carte-meta">${LIBELLE_STATUT[s.statut] || ""}</span>
      <span class="carte-note"></span>`;

    el.addEventListener("click", async () => {
      try { ouvrirFiche(await parIdentifiant(s.id)); }
      catch { ouvrirFiche(depuisSuivi(s)); }     // hors ligne : on affiche ce qu'on a
    });
    observateurNotes.observe(el);
    grille.appendChild(el);
  });
}

const LIBELLE_STATUT = {
  a_voir: "À voir", en_cours: "En cours",
  termine: "Terminé", abandonne: "Abandonné"
};

/* Reconstitue une fiche minimale depuis ce qui est enregistré, pour que la
   consultation reste possible sans réseau. */
const depuisSuivi = (s) => ({
  id: s.id, title: s.title, cover: s.cover, resume: "",
  episodes: s.episodes, format: "", statutDiff: "", saison: "",
  annee: null, genres: [], hype: 0, favoris: 0, debut: null,
  prochain: null, studio: ""
});

function rafraichirCartes() {
  document.querySelectorAll(".carte[data-anime]").forEach((el) => {
    const suivi = listeCache.find((s) => s.id === el.dataset.anime);
    const img = el.querySelector(".carte-img");
    const badge = img.querySelector(".carte-suivi");
    if (suivi && !badge && !el.closest("#liste")) {
      img.insertAdjacentHTML("beforeend", `<span class="carte-suivi">Suivi</span>`);
    } else if (!suivi && badge && !el.closest("#liste")) {
      badge.remove();
    }
  });
}

/* ══════════════════ Fiche ══════════════════ */

function ouvrirFiche(a) {
  ficheCourante = a;
  majFiche();
  afficherNotes(a.id);
  showView("fiche");
}

function majFiche() {
  const a = ficheCourante;
  if (!a) return;
  const suivi = listeCache.find((s) => s.id === a.id);

  $("fiche-cover").src = a.cover || "";
  $("fiche-titre").textContent = a.title;

  const bouts = [FORMATS[a.format] || a.format, a.studio,
                 a.episodes ? `${a.episodes} épisodes` : null, dateDebut(a)];
  $("fiche-sous").textContent = bouts.filter(Boolean).join(" · ");

  $("fiche-genres").innerHTML = a.genres
    .map((g) => `<span class="etiquette">${escapeHtml(g)}</span>`).join("");

  if (a.prochain) {
    $("fiche-diffusion").textContent =
      `Épisode ${a.prochain.episode} ${compteARebours(a.prochain.timeUntilAiring)}`;
    $("fiche-diffusion").hidden = false;
  } else if (a.statutDiff === "NOT_YET_RELEASED") {
    $("fiche-diffusion").textContent = `Sortie prévue : ${dateDebut(a)} · ${nombreCourt(a.hype)} personnes l'attendent`;
    $("fiche-diffusion").hidden = false;
  } else {
    $("fiche-diffusion").hidden = true;
  }

  $("fiche-resume").textContent = a.resume || "";

  $("fiche-suivi").hidden   = !suivi;
  $("fiche-danger").hidden  = !suivi;
  $("fiche-ajouter").hidden = !!suivi;
  $("fiche-ajouter").textContent = currentUser
    ? "Ajouter à ma liste"
    : "Créer un compte pour suivre cette série";

  if (!suivi) return;

  const total = suivi.episodes || 0;
  const pct = total ? Math.round((suivi.vus / total) * 100) : 0;
  $("fiche-barre").style.width = `${pct}%`;
  $("fiche-progression").textContent = total
    ? `${suivi.vus} épisodes sur ${total}${suivi.vus < total ? ` — il t'en reste ${total - suivi.vus}` : " — terminé"}`
    : `${suivi.vus} épisodes vus`;

  $("ep-moins").disabled = suivi.vus <= 0;
  $("ep-plus").disabled  = total > 0 && suivi.vus >= total;
  $("ep-plus").textContent = total > 0 && suivi.vus >= total
    ? "Série terminée" : "J'ai vu l'épisode suivant";

  document.querySelectorAll(".statut").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.statut === suivi.statut));
}

$("fiche-ajouter").addEventListener("click", async () => {
  const a = ficheCourante;
  if (!a) return;
  if (!currentUser) return ouvrirConnexion("Crée un compte pour suivre cette série.");
  try {
    await setDoc(doc(db, "users", currentUser.uid, "animes", a.id), {
      id: a.id, title: a.title, cover: a.cover,
      episodes: a.episodes || 0, vus: 0,
      statut: a.statutDiff === "NOT_YET_RELEASED" ? "a_voir" : "en_cours",
      addedAt: Date.now()
    });
    toast(`${a.title} est dans ta liste.`);
  } catch (err) {
    console.error("Ajout :", err.code, err.message);
    toast("L'ajout a échoué.");
  }
});

const majSuivi = (id, champs) =>
  updateDoc(doc(db, "users", currentUser.uid, "animes", id), champs);

$("ep-plus").addEventListener("click", async () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (!s) return;
  const vus = s.vus + 1;
  // Atteindre le dernier épisode fait passer la série en « terminé » d'office.
  const statut = s.episodes && vus >= s.episodes ? "termine" : "en_cours";
  await majSuivi(s.id, { vus, statut });
});

$("ep-moins").addEventListener("click", async () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (!s || s.vus <= 0) return;
  await majSuivi(s.id, { vus: s.vus - 1, statut: "en_cours" });
});

/* Saisir directement un numéro évite trente clics à qui reprend une série
   en cours de route — et trente écritures Firestore. */
$("ep-choisir").addEventListener("click", async () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (!s) return;

  const max = s.episodes || 9999;
  const saisi = prompt(`Combien d'épisodes as-tu vus de « ${s.title} » ?`, String(s.vus));
  if (saisi === null) return;

  const vus = Number(saisi);
  if (!Number.isInteger(vus) || vus < 0 || vus > max) {
    return toast(`Indique un nombre entre 0 et ${max}.`);
  }
  const statut = s.episodes && vus >= s.episodes ? "termine"
               : vus > 0 ? "en_cours" : s.statut;
  await majSuivi(s.id, { vus, statut });
  toast("Progression mise à jour.");
});

document.querySelectorAll(".statut").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const s = listeCache.find((x) => x.id === ficheCourante?.id);
    if (!s) return;
    await majSuivi(s.id, { statut: btn.dataset.statut });
  });
});

$("fiche-retirer").addEventListener("click", async () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (!s) return;
  if (!confirm(`Retirer « ${s.title} » de ta liste ?`)) return;
  await deleteDoc(doc(db, "users", currentUser.uid, "animes", s.id));
  toast("Retiré de ta liste.");
  showView("liste");
});

/* ══════════════════ Notes ══════════════════

   Un vote par personne, la moyenne calculée par Firestore plutôt que stockée :
   un compteur cumulé serait impossible à protéger, aucune règle ne pouvant
   vérifier qu'une somme correspond aux votes réels.
   ══════════════════════════════════════════ */

const notesCache = new Map();
const votesDe = (id) => collection(db, "notes", id, "votes");

async function chargerNote(id, forcer = false) {
  if (!forcer && notesCache.has(id)) return notesCache.get(id);

  /* La moyenne est publique ; la note personnelle n'existe que si quelqu'un
     est connecté. On ne demande donc le second document que dans ce cas. */
  const [agg, mien] = await Promise.all([
    getAggregateFromServer(votesDe(id), { moyenne: average("note"), nombre: count() }),
    currentUser ? getDoc(doc(votesDe(id), currentUser.uid)) : Promise.resolve(null)
  ]);

  const n = {
    moyenne: agg.data().moyenne,
    nombre:  agg.data().nombre,
    mienne:  mien?.exists() ? mien.data().note : null
  };
  notesCache.set(id, n);
  return n;
}

const chiffreNote = (v) => v.toFixed(1).replace(".", ",");

const texteNote = (n) =>
  n.moyenne === null ? "Pas encore noté"
                     : `${chiffreNote(n.moyenne)} / 10 · ${n.nombre} avis`;

const htmlNote = (n) =>
  n.moyenne === null
    ? `<span class="note-vide">Pas encore noté</span>`
    : `<span class="note-chiffre">${chiffreNote(n.moyenne)}</span>`
    + `<span class="note-sur">/ 10</span>`
    + `<span class="note-avis">${n.nombre} avis</span>`;

async function afficherNotes(id) {
  $("fiche-note").innerHTML = `<span class="note-vide">Chargement…</span>`;
  try {
    const n = await chargerNote(id);
    if (ficheCourante?.id !== id) return;   // la personne a changé de fiche
    $("fiche-note").innerHTML = htmlNote(n);
    grilleNotes(n, id);
  } catch (err) {
    console.error("Notes :", err.code, err.message);
    $("fiche-note").innerHTML = `<span class="note-vide">Notes indisponibles.</span>`;
  }
}

function grilleNotes(n, id) {
  const zone = $("fiche-notes");
  zone.innerHTML = "";

  for (let i = 1; i <= 10; i++) {
    const atteint = n.mienne !== null && i <= n.mienne;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "note-btn" + (atteint ? " is-atteint" : "") + (n.mienne === i ? " is-active" : "");
    b.textContent = i;
    b.setAttribute("aria-pressed", n.mienne === i);
    b.addEventListener("click", () => noter(id, n.mienne === i ? null : i));
    zone.appendChild(b);
  }

  const info = document.createElement("span");
  info.className = "note-mienne";
  info.textContent = n.mienne
    ? `Ta note : ${n.mienne} sur 10 — clique à nouveau dessus pour la retirer`
    : "Tu n'as pas encore noté cette série";
  zone.appendChild(info);
}

async function noter(id, valeur) {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour noter les séries.");
  try {
    const ref = doc(votesDe(id), currentUser.uid);
    if (valeur === null) await deleteDoc(ref);
    else await setDoc(ref, { note: valeur, at: Date.now() });

    await chargerNote(id, true);
    if (ficheCourante?.id === id) afficherNotes(id);
    toast(valeur === null ? "Note retirée." : `Noté ${valeur} sur 10.`);
  } catch (err) {
    console.error("Note :", err.code, err.message);
    toast("La note n'a pas pu être enregistrée.");
  }
}

/* ══════════════════ Fond réactif ══════════════════ */

(function fondReactif() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const racine = document.documentElement;
  let enAttente = false;

  const majuster = () => {
    const hauteur = racine.scrollHeight - window.innerHeight;
    const part = hauteur > 0 ? Math.min(1, window.scrollY / hauteur) : 0;
    const x = Math.sin(part * 8.2 + 0.9) * 20 + Math.sin(part * 17.5 + 1.2) * 9;
    const y = part * 104 + Math.sin(part * 8.6) * 11;
    racine.style.setProperty("--defile", part.toFixed(4));
    racine.style.setProperty("--halo-x", x.toFixed(2));
    racine.style.setProperty("--halo-y", y.toFixed(2));
    enAttente = false;
  };

  const auDefilement = () => {
    if (enAttente) return;
    enAttente = true;
    requestAnimationFrame(majuster);
  };

  addEventListener("scroll", auDefilement, { passive: true });
  addEventListener("resize", auDefilement);
  majuster();
})();

/* ══════════════════ Application installable ══════════════════ */

if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .catch((err) => console.warn("Service worker non enregistré :", err.message));
  });
}

/* ══════════════════ Utilitaires ══════════════════ */

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

