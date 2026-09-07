import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut, onAuthStateChanged,
  deleteUser, reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, deleteField, writeBatch,
  onSnapshot, query, orderBy
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
  externalLinks { url site type language isDisabled }
`;

/* AniList limite le rythme des appels et répond 429 quand on le dépasse.
   L'import enchaîne les requêtes : sans cette attente, une liste un peu
   longue s'arrêterait en plein milieu. */
async function anilist(query, variables = {}, options = {}) {
  const { essais = 3, onAttente = null } = options;

  const res = await fetch(ANILIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query, variables })
  });

  if (res.status === 429 && essais > 0) {
    const secondes = Math.min(Number(res.headers.get("Retry-After")) || 60, 65);
    onAttente?.(secondes);
    await pause(secondes * 1000);
    return anilist(query, variables, { ...options, essais: essais - 1 });
  }

  if (!res.ok) throw new Error(`AniList a répondu ${res.status}`);
  const json = await res.json();

  /* Une requête groupée pose douze questions à la fois. Si l'une d'elles
     déplaît au serveur, AniList renvoie l'erreur *et* les onze réponses
     valides. Rejeter le tout perdait onze séries pour une. */
  if (json.errors?.length) {
    if (!json.data) throw new Error(json.errors[0].message);
    console.warn("AniList, réponse partielle :", json.errors[0].message);
  }
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
  studio:    m.studios?.nodes?.[0]?.name || "",
  liens:     plateformes(m.externalLinks)
});

/* AniList référence les liens externes d'une série : sites officiels, réseaux,
   et plateformes de diffusion. On ne garde que ces dernières.

   Le champ « language » dit dans quelle langue est le service — « French »
   pour ADN, pour la page française de Crunchyroll. Il ne dit pas si la série
   y est doublée ou sous-titrée : cette information n'existe nulle part dans
   l'API. On annonce donc « disponible en français », ce qui est vrai, plutôt
   que « VF » ou « VOSTFR », ce qu'on ne sait pas. */
function plateformes(liens) {
  return (liens || [])
    .filter((l) => l.type === "STREAMING" && !l.isDisabled && l.url)
    .map((l) => ({
      url:  l.url,
      site: l.site || "Plateforme",
      fr:   /fran[çc]ais|french/i.test(l.language || "")
    }))
    // Les services francophones d'abord : c'est ce qu'on cherche ici.
    .sort((a, b) => Number(b.fr) - Number(a.fr));
}

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

/* Rouvrir la même fiche dans la session ne redemande rien : une série ne
   change pas de résumé en dix minutes. */
const ficheCache = new Map();

async function parIdentifiant(id) {
  if (ficheCache.has(id)) return ficheCache.get(id);

  const d = await anilist(
    `query ($id: Int) { Media(id: $id, type: ANIME) { ${CHAMPS} } }`,
    { id: Number(id) });

  const a = normaliser(d.Media);
  ficheCache.set(id, a);
  return a;
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
  $("supprimer-compte").hidden = !connecte;
  $("ouvrir-connexion").hidden = connecte;
  $("liste-invite").hidden     = connecte;
  $("liste-contenu").hidden    = !connecte;

  if (!connecte) {
    montrerAvatar(null);
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    listeCache = [];
    profilsCharges = false;
    if (ficheCourante) majFiche();
    rafraichirCartes();
    return;
  }

  fermerConnexion();
  $("user-email").textContent = user.displayName || user.email;
  suivreListe(user.uid);

  try {
    const profil = await getDoc(doc(db, "users", user.uid));
    if (profil.exists()) {
      if (profil.data().pseudo) $("user-email").textContent = profil.data().pseudo;
      montrerAvatar(profil.data().avatar);
    }
    chargerEtatPublication();
  } catch { /* le profil n'est pas indispensable à l'affichage */ }
});

/* ══════════════════ Fenêtre de connexion ══════════════════ */

/* motif : message d'explication quand l'ouverture est provoquée par une action
   qui exige un compte. modeVoulu : « signup » pour arriver directement sur la
   création, puisqu'un bouton « Créer un compte » qui ouvre l'écran de
   connexion demande un clic de plus pour rien. */
function ouvrirConnexion(motif, modeVoulu = "login") {
  $("auth-screen").hidden = false;
  showReset(false);
  appliquerMode(modeVoulu);
  if (motif) toast(motif);
  setTimeout(() => $("email").focus(), 100);
}

function fermerConnexion() {
  $("auth-screen").hidden = true;
  hideError();
}

$("ouvrir-connexion").addEventListener("click", () => ouvrirConnexion(null, "signup"));
$("invite-connexion").addEventListener("click", () => ouvrirConnexion(null, "signup"));
$("auth-fermer").addEventListener("click", fermerConnexion);

// Clic sur le fond, ou touche Échap : deux façons attendues de refermer.
$("auth-screen").addEventListener("click", (e) => {
  if (e.target === $("auth-screen")) fermerConnexion();
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("auth-screen").hidden) fermerConnexion();
});

/* Un seul endroit décide de l'apparence du formulaire. Le bouton de bascule et
   l'ouverture directe en création passent tous les deux par ici, sans quoi les
   deux chemins finissent par diverger. */
function appliquerMode(m) {
  mode = m;
  const signup = m === "signup";

  $("auth-titre").textContent       = signup ? "Créer ton compte" : "Se connecter";
  $("auth-submit").textContent      = signup ? "Créer mon compte" : "Se connecter";
  $("auth-switch-text").textContent = signup ? "Tu as déjà un compte ?" : "Pas encore de compte ?";
  $("auth-toggle").textContent      = signup ? "Se connecter" : "Créer un compte";
  $("password").autocomplete        = signup ? "new-password" : "current-password";
  $("auth-forgot-wrap").hidden      = signup;
  $("pseudo-field").hidden          = !signup;
  $("pseudo").required              = signup;
  $("avatar-field").hidden          = !signup;
  hideError();
}

$("auth-toggle").addEventListener("click", () =>
  appliquerMode(mode === "login" ? "signup" : "login"));

/* ══════════════════ Avatars ══════════════════

   Six images posées dans le dossier « avatar/ ». C'est la seule liste à
   modifier pour en ajouter, en retirer ou en renommer : le formulaire se
   construit à partir d'elle, et les règles Firestore n'acceptent qu'un
   identifiant de cette forme.
   ═════════════════════════════════════════════ */

const AVATARS = ["femme_1", "femme_2", "femme_3", "homme_1", "homme_2", "homme_3"];

const cheminAvatar = (id) => `avatar/${id}.png`;

let avatarChoisi = null;

(function construireAvatars() {
  const zone = $("avatar-choix");

  AVATARS.forEach((id) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-option";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", `Avatar ${id.replace("_", " ")}`);

    const img = document.createElement("img");
    img.src = cheminAvatar(id);
    img.alt = "";
    img.loading = "lazy";
    btn.appendChild(img);

    btn.addEventListener("click", () => {
      // Recliquer sur le même avatar l'enlève : le choix reste facultatif.
      avatarChoisi = avatarChoisi === id ? null : id;
      zone.querySelectorAll(".avatar-option").forEach((b, i) => {
        const actif = AVATARS[i] === avatarChoisi;
        b.classList.toggle("is-active", actif);
        b.setAttribute("aria-pressed", String(actif));
      });
    });

    zone.appendChild(btn);
  });
})();

/* Affiche l'avatar à côté du pseudo. Un compte sans avatar — les anciens, ou
   ceux qui n'en ont pas voulu — se contente de son pseudo. */
function montrerAvatar(id) {
  const img = $("user-avatar");
  const valide = id && AVATARS.includes(id);
  img.hidden = !valide;
  if (valide) img.src = cheminAvatar(id);
}

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
    const profil = { pseudo, createdAt: Date.now() };
    // Champ absent plutôt que vide : les règles refusent une valeur inconnue,
    // et un compte sans avatar est un cas normal.
    if (avatarChoisi) profil.avatar = avatarChoisi;

    await setDoc(doc(db, "usernames", cle), { uid: user.uid });
    await setDoc(doc(db, "users", user.uid), profil);
    await updateProfile(user, { displayName: pseudo });
    $("user-email").textContent = pseudo;
    montrerAvatar(avatarChoisi);
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
let vueAffichee   = "avenir";

/* Position de défilement de chaque vue. Ouvrir une série depuis le bas d'une
   liste de trois cents jaquettes puis revenir tout en haut oblige à refaire
   tout le chemin — et à retrouver de mémoire où l'on en était. */
const defilements = {};

function showView(nom) {
  // On note où l'on en était avant de quitter la vue courante.
  if (vueAffichee) defilements[vueAffichee] = window.scrollY;
  vueAffichee = nom;

  if (nom !== "fiche" && nom !== "profil") vuePrecedente = nom;

  $("view-avenir").hidden    = nom !== "avenir";
  $("view-decouvrir").hidden = nom !== "decouvrir";
  $("view-succes").hidden    = nom !== "succes";
  $("view-profils").hidden   = nom !== "profils";
  $("view-profil").hidden    = nom !== "profil";
  $("view-liste").hidden     = nom !== "liste";
  $("view-fiche").hidden     = nom !== "fiche";

  /* Ni la fiche ni le profil d'un membre n'ont d'onglet à eux : on garde en
     surbrillance celui d'où l'on vient. */
  const onglet = (nom === "fiche" || nom === "profil") ? vuePrecedente : nom;

  document.querySelectorAll("[data-vue]").forEach((btn) => {
    const actif = btn.dataset.vue === onglet;
    btn.classList.toggle("is-active", actif);
    btn.setAttribute("aria-current", actif ? "page" : "false");
  });

  if (nom === "profils") chargerProfils();
  if (nom === "succes")  afficherSucces();

  const rang = ["avenir", "decouvrir", "profils", "liste", "succes"].indexOf(onglet);
  document.querySelector(".barre-basse")?.style.setProperty("--onglet", rang);

  if (nom !== "fiche") ficheCourante = null;

  /* Une fiche ou un profil qu'on vient d'ouvrir commence en haut : c'est un
     contenu neuf. Une liste retrouvée reprend là où on l'avait laissée.
     Le report à la trame suivante laisse au navigateur le temps de calculer
     la hauteur de la grille qu'on vient de réafficher. */
  const cible = (nom === "fiche" || nom === "profil") ? 0 : (defilements[nom] || 0);
  requestAnimationFrame(() => window.scrollTo(0, cible));
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

/* Une série saisie à la main n'a pas toujours d'image. Un <img src=""> fait
   afficher au navigateur son icône d'image cassée : on met un carré aux
   initiales à la place, qui a au moins l'air voulu. */
const initiales = (titre) => String(titre || "?")
  .split(/\s+/).filter(Boolean).slice(0, 2)
  .map((m) => m[0]).join("").toUpperCase() || "?";

const jaquette = (url, titre) => url
  ? `<img src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="carte-sans-image">${escapeHtml(initiales(titre))}</span>`;

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
      ${jaquette(a.cover, a.title)}
      ${genre === "avenir" ? `<span class="carte-hype">${nombreCourt(a.hype)} en attente</span>` : ""}
      ${suivi ? `<span class="carte-suivi">Suivi</span>` : ""}
      ${bandeau ? `<span class="carte-bandeau">${escapeHtml(bandeau)}</span>` : ""}
    </span>
    <span class="carte-nom">${escapeHtml(a.title)}</span>
    <span class="carte-meta">${escapeHtml(FORMATS[a.format] || a.format)}${a.annee ? ` · ${a.annee}` : ""}</span>
    <span class="carte-note">${texteNote(suivi)}</span>`;

  el.__anime = a;
  return el;
}

/* Un seul écouteur pour toutes les cartes, posé sur le document.

   Auparavant chaque carte portait le sien. Or les grilles sont reconstruites
   de fond en comble : « Ma liste » à chaque retour de Firestore, les résultats
   de recherche à chaque frappe. Si la reconstruction tombe entre le moment où
   le doigt touche l'écran et celui où il le quitte, la carte touchée n'existe
   plus, son écouteur est parti avec elle, et le toucher n'aboutit nulle part —
   la carte s'éclaire pourtant, parce que la surbrillance, elle, est du CSS.
   Un écouteur délégué survit à toutes les reconstructions. */
document.addEventListener("click", async (ev) => {
  const el = ev.target.closest?.(".carte");
  if (!el) return;

  if (el.__apercu) return ouvrirApercu(el.__apercu);

  const suivi = el.__suivi;
  if (suivi) {
    /* On ouvre immédiatement avec ce que la liste contient déjà — titre,
       jaquette, progression, note. Attendre la réponse d'AniList avant
       d'afficher quoi que ce soit laissait l'écran figé une seconde ou deux,
       le temps d'un aller-retour réseau, sans que rien n'indique qu'il se
       passait quelque chose.

       Le résumé, les genres et le studio arrivent ensuite et complètent la
       fiche sur place. Si entre-temps tu es reparti ailleurs, la réponse est
       ignorée : elle ne doit pas écraser la fiche que tu regardes. */
    ouvrirFiche(depuisSuivi(suivi));
    if (estLocale(suivi.id)) return;

    $("fiche-resume").textContent = "Chargement des détails…";
    try {
      const complet = await parIdentifiant(suivi.id);
      if (ficheCourante?.id === suivi.id) { ficheCourante = complet; majFiche(); }
    } catch {
      if (ficheCourante?.id === suivi.id) $("fiche-resume").textContent = "";
    }
    return;
  }
  if (el.__anime) ouvrirFiche(el.__anime);
});

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
    majPublication();
    if (!$("view-succes").hidden) afficherSucces();
    planifierVitrine();   // les compteurs publiés suivent la liste
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

/* ══════════════════ Tri des listes ══════════════════

   Le même tri sert à ta liste et à celle d'un profil consulté : c'est une
   préférence de lecture, pas une propriété des données. Elle est retenue d'une
   visite à l'autre.
   ════════════════════════════════════════════════════ */

const TRIS = {
  defaut: "En cours d'abord",
  ajout:  "Ordre d'ajout",
  recent: "Ajouts récents",
  alpha:  "Alphabétique"
};

let rechercheListe = "";

$("liste-recherche").addEventListener("input", (e) => {
  rechercheListe = e.target.value;
  afficherListe();
});

let triCourant = "defaut";
try { triCourant = localStorage.getItem("animezone-tri") || "defaut"; } catch {}
if (!TRIS[triCourant]) triCourant = "defaut";

const parTitre = (a, b) =>
  a.title.localeCompare(b.title, "fr", { sensitivity: "base", numeric: true });

function trier(liste) {
  const copie = [...liste];

  // Les séries en cours d'abord : c'est ce qu'on vient consulter.
  const rang = (s) => (s.statut === "en_cours" ? 0 : s.statut === "a_voir" ? 1 : 2);

  switch (triCourant) {
    case "alpha":  return copie.sort(parTitre);
    case "ajout":  return copie.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || parTitre(a, b));
    case "recent": return copie.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || parTitre(a, b));
    default:       return copie.sort((a, b) => rang(a) - rang(b) || parTitre(a, b));
  }
}

/* Un <select> natif ne se style pas : la liste qui s'ouvre est dessinée par le
   système, blanche et carrée au milieu d'une interface sombre. On construit
   donc le menu à la main — un bouton et un panneau — pour qu'il ressemble au
   reste du site. Le comportement clavier et les rôles ARIA reproduisent ce que
   le select offrait gratuitement. */
const rappelsTri = [];

function construireTri(id, auChangement) {
  const hote = $(id);
  hote.innerHTML = "";

  const bouton = document.createElement("button");
  bouton.type = "button";
  bouton.className = "tri-bouton";
  bouton.setAttribute("aria-haspopup", "listbox");
  bouton.setAttribute("aria-expanded", "false");
  bouton.setAttribute("aria-label", hote.dataset.libelle || "Trier");
  bouton.innerHTML = `
    <svg class="tri-icone" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5v14M7 19l-3-3M7 19l3-3M17 19V5M17 5l-3 3M17 5l3 3"/>
    </svg>
    <span class="tri-valeur"></span>
    <svg class="tri-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

  const menu = document.createElement("div");
  menu.className = "tri-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  const lignes = Object.entries(TRIS).map(([cle, libelle]) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "tri-option";
    opt.setAttribute("role", "option");
    opt.innerHTML = `<span>${libelle}</span>
      <svg class="tri-coche" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>`;
    opt.addEventListener("click", () => {
      triCourant = cle;
      try { localStorage.setItem("animezone-tri", triCourant); } catch {}
      fermerTris();
      rappelsTri.forEach((f) => f());     // les deux menus suivent le même choix
    });
    menu.appendChild(opt);
    return { cle, opt };
  });

  const peindre = () => {
    bouton.querySelector(".tri-valeur").textContent = TRIS[triCourant];
    lignes.forEach(({ cle, opt }) => {
      const actif = cle === triCourant;
      opt.classList.toggle("is-active", actif);
      opt.setAttribute("aria-selected", String(actif));
    });
  };

  bouton.addEventListener("click", (e) => {
    e.stopPropagation();
    const ouvert = !menu.hidden;
    fermerTris();
    if (!ouvert) {
      menu.hidden = false;
      bouton.setAttribute("aria-expanded", "true");
      lignes.find((l) => l.cle === triCourant)?.opt.focus();
    }
  });

  hote.append(bouton, menu);
  peindre();

  rappelsTri.push(() => { peindre(); auChangement(); });
  return peindre;
}

function fermerTris() {
  document.querySelectorAll(".tri-menu").forEach((m) => { m.hidden = true; });
  document.querySelectorAll(".tri-bouton").forEach((b) =>
    b.setAttribute("aria-expanded", "false"));
}

document.addEventListener("click", fermerTris);
addEventListener("keydown", (e) => { if (e.key === "Escape") fermerTris(); });

construireTri("tri-liste", () => afficherListe());
construireTri("tri-profil", () => afficherListeProfil());

function afficherListe() {
  const grille = $("liste");
  grille.innerHTML = "";

  $("stats").hidden = listeCache.length === 0;

  const episodes = listeCache.reduce((n, s) => n + s.vus, 0);
  const termines = listeCache.filter(estTermine).length;

  $("stat-suivis").textContent   = listeCache.length;
  $("stat-episodes").textContent = episodes;
  $("stat-termines").textContent = termines;

  /* La recherche est purement locale : la liste est déjà en mémoire, aucune
     requête n'est nécessaire. Le titre est normalisé des deux côtés — sans
     accents ni ponctuation — pour que « re zero » trouve « Re:ZERO ». */
  const cherche = cleTitre(rechercheListe);

  const visibles = trier(listeCache
    .filter((s) => filtreStatut === "tous" || s.statut === filtreStatut)
    .filter((s) => !cherche || cleTitre(s.title).includes(cherche)));

  if (listeCache.length === 0) {
    $("liste-vide").textContent =
      "Rien ici pour l'instant. Passe par À venir ou Découvrir pour ajouter une série.";
    $("liste-vide").hidden = false;
  } else if (visibles.length === 0) {
    $("liste-vide").textContent = cherche
      ? `Aucune série de ta liste ne correspond à « ${rechercheListe.trim()} ».`
      : "Aucune série avec ce statut.";
    $("liste-vide").hidden = false;
  } else {
    $("liste-vide").hidden = true;
  }

  visibles.forEach((s) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "carte";
    el.dataset.anime = s.id;

    const pct = s.episodes ? Math.round((s.vus / s.episodes) * 100) : 0;
    el.innerHTML = `
      <span class="carte-img">
        ${jaquette(s.cover, s.title)}
        ${estTermine(s) ? `<span class="carte-suivi">Terminé</span>` : ""}
        <span class="carte-bandeau">${s.vus} / ${s.episodes || "?"} épisodes${s.episodes ? ` · ${pct} %` : ""}</span>
      </span>
      <span class="carte-nom">${escapeHtml(s.title)}</span>
      <span class="carte-meta">${LIBELLE_STATUT[s.statut] || ""}</span>
      <span class="carte-note">${texteNote(s)}</span>`;

    el.__suivi = s;
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
  locale: estLocale(s.id),
  id: s.id, title: s.title, cover: s.cover, resume: "",
  episodes: s.episodes, format: "", statutDiff: "", saison: "",
  annee: null, genres: [], hype: 0, favoris: 0, debut: null,
  prochain: null, studio: ""
});

function rafraichirCartes() {
  document.querySelectorAll(".carte[data-anime]").forEach((el) => {
    const suivi = listeCache.find((s) => s.id === el.dataset.anime);

    const note = el.querySelector(".carte-note");
    if (note) note.textContent = texteNote(suivi);

    const img = el.querySelector(".carte-img");
    const badge = img.querySelector(".carte-suivi");
    if (suivi && !badge && !el.closest("#liste")) {
      img.insertAdjacentHTML("beforeend", `<span class="carte-suivi">Suivi</span>`);
    } else if (!suivi && badge && !el.closest("#liste")) {
      badge.remove();
    }
  });
}

/* ══════════════════ Suppression du compte ══════════════════

   Un compte qu'on ne peut pas supprimer n'est pas vraiment à soi. La
   suppression est donc réelle et complète, pas un simple drapeau posé sur le
   profil : la liste, les notes, la réservation du pseudo, la vitrine publique
   et le compte d'authentification lui-même disparaissent.

   L'ordre compte. On réauthentifie d'abord — Firebase l'exige pour une
   opération aussi lourde, et ça vérifie que c'est bien le titulaire du compte
   qui est devant l'écran. On efface ensuite les données, tant que les règles
   nous y autorisent encore. Le compte d'authentification part en dernier :
   une fois lui supprimé, plus aucune écriture n'est possible et ce qui
   resterait serait irrécupérable, sans propriétaire pour y accéder.
   ═══════════════════════════════════════════════════════════ */

const MOT_CONFIRMATION = "SUPPRIMER";

function ouvrirSuppression() {
  if (!currentUser) return;
  $("supprimer-screen").hidden = false;
  $("supprimer-mot").value = "";
  $("supprimer-mdp").value = "";
  $("supprimer-erreur").hidden = true;
  $("supprimer-detail").textContent =
    `${listeCache.length} série${listeCache.length > 1 ? "s" : ""} suivie${listeCache.length > 1 ? "s" : ""}` +
    `, tes notes, ton pseudo et ton profil public s'il est publié.`;
  setTimeout(() => $("supprimer-mot").focus(), 100);
}

const fermerSuppression = () => { $("supprimer-screen").hidden = true; };

$("supprimer-compte").addEventListener("click", ouvrirSuppression);
$("supprimer-fermer").addEventListener("click", fermerSuppression);
$("supprimer-annuler").addEventListener("click", fermerSuppression);
$("supprimer-screen").addEventListener("click", (e) => {
  if (e.target === $("supprimer-screen")) fermerSuppression();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("supprimer-screen").hidden) fermerSuppression();
});

function erreurSuppression(msg) {
  $("supprimer-erreur").textContent = msg;
  $("supprimer-erreur").hidden = false;
}

/* Firestore ne supprime pas une sous-collection en supprimant son parent :
   chaque document doit partir explicitement. On les efface par lots. */
async function effacerDonnees(uid, pseudo) {
  const OPS = 400;
  const refs = [];

  const animes = await getDocs(collection(db, "users", uid, "animes"));
  animes.forEach((d) => refs.push(doc(db, "users", uid, "animes", d.id)));

  // Votes publics laissés par l'ancienne version du site. Ils ne sont plus
  // écrits, mais ceux d'avant existent toujours et portent ton identifiant.
  listeCache.forEach((s) => {
    if (!estLocale(s.id)) refs.push(doc(db, "notes", s.id, "votes", uid));
  });

  refs.push(doc(db, "profilsPublics", uid));
  if (pseudo) refs.push(doc(db, "usernames", pseudo.toLowerCase()));
  refs.push(doc(db, "users", uid));

  for (let i = 0; i < refs.length; i += OPS) {
    const lot = writeBatch(db);
    refs.slice(i, i + OPS).forEach((r) => lot.delete(r));
    await lot.commit();
  }
  return refs.length;
}

$("supprimer-valider").addEventListener("click", async () => {
  if (!currentUser) return;

  if ($("supprimer-mot").value.trim().toUpperCase() !== MOT_CONFIRMATION) {
    return erreurSuppression(`Écris ${MOT_CONFIRMATION} en toutes lettres pour confirmer.`);
  }
  const mdp = $("supprimer-mdp").value;
  if (!mdp) return erreurSuppression("Ton mot de passe est nécessaire pour confirmer.");

  $("supprimer-valider").disabled = true;
  $("supprimer-valider").textContent = "Suppression…";

  try {
    const user = currentUser;
    const uid  = user.uid;

    await reauthenticateWithCredential(
      user, EmailAuthProvider.credential(user.email, mdp));

    // Le pseudo est lu avant l'effacement : après, le profil n'existe plus.
    let pseudo = null;
    try { pseudo = (await getDoc(doc(db, "users", uid))).data()?.pseudo || null; } catch {}

    if (unsubscribe) { unsubscribe(); unsubscribe = null; }   // plus d'écoute pendant l'effacement

    await effacerDonnees(uid, pseudo);
    await deleteUser(user);

    fermerSuppression();
    toast("Ton compte et toutes tes données ont été supprimés.");
  } catch (err) {
    console.error("Suppression :", err.code, err.message);
    erreurSuppression(
      err.code === "auth/wrong-password" || err.code === "auth/invalid-credential"
        ? "Mot de passe incorrect."
        : err.code === "auth/too-many-requests"
          ? "Trop de tentatives. Réessaie dans quelques minutes."
          : "La suppression a échoué. Tes données sont intactes, réessaie.");
  } finally {
    $("supprimer-valider").disabled = false;
    $("supprimer-valider").textContent = "Supprimer définitivement";
  }
});

/* ══════════════════ Succès ══════════════════

   Tout se calcule à la volée depuis la liste déjà en mémoire : rien n'est
   stocké, rien n'est écrit, aucun succès ne peut se désynchroniser des données
   qu'il décrit. Retirer une série retire le succès qu'elle avait débloqué, ce
   qui est la seule définition honnête d'un compteur.

   Seuls les genres manquent aux séries importées avant que le site ne pense à
   les conserver. D'où le rattrapage, qui les redemande à AniList une fois.
   ════════════════════════════════════════════ */

const SUCCES = [
  { famille: "Parcours", titre: "Premiers pas",         desc: "Terminer une première série", cible: 1,    mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Habitué",              desc: "Terminer 10 séries",          cible: 10,   mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Vétéran",              desc: "Terminer 50 séries",          cible: 50,   mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Bibliothèque vivante", desc: "Terminer 150 séries",         cible: 150,  mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Grand collectionneur", desc: "Terminer 300 séries",         cible: 300,  mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Encyclopédie",         desc: "Terminer 500 séries",         cible: 500,  mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Conservateur",         desc: "Terminer 750 séries",         cible: 750,  mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Les mille",            desc: "Terminer 1 000 séries",       cible: 1000, mesure: (b) => b.termines },

  { famille: "Temps passé", titre: "Cent épisodes",     desc: "Voir 100 épisodes",           cible: 100,   mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Habitude prise",    desc: "Voir 500 épisodes",           cible: 500,   mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Marathonien",       desc: "Voir 1 000 épisodes",         cible: 1000,  mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Insomniaque",       desc: "Voir 2 500 épisodes",         cible: 2500,  mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Increvable",        desc: "Voir 5 000 épisodes",         cible: 5000,  mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Sans relâche",      desc: "Voir 7 500 épisodes",         cible: 7500,  mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Dix mille",         desc: "Voir 10 000 épisodes",        cible: 10000, mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Longue haleine",    desc: "Terminer une série de 100 épisodes ou plus", cible: 1, mesure: (b) => b.fleuve },

  { famille: "Curiosité", titre: "Éclectique",         desc: "Avoir vu 5 genres différents",       cible: 5,    mesure: (b) => b.genres.size, besoinGenres: true },
  { famille: "Curiosité", titre: "Touche-à-tout",      desc: "Avoir vu 10 genres différents",      cible: 10,   mesure: (b) => b.genres.size, besoinGenres: true },
  { famille: "Curiosité", titre: "Rien ne t'échappe",  desc: "Avoir vu 15 genres différents",      cible: 15,   mesure: (b) => b.genres.size, besoinGenres: true },
  { famille: "Curiosité", titre: "Grand écran",        desc: "Terminer 5 films",                   cible: 5,    mesure: (b) => b.films, besoinGenres: true },

  { famille: "Tenue de liste", titre: "Premier avis",  desc: "Noter une série",                    cible: 1,    mesure: (b) => b.notees },
  { famille: "Tenue de liste", titre: "Critique",      desc: "Noter 50 séries",                    cible: 50,   mesure: (b) => b.notees },
  { famille: "Tenue de liste", titre: "Juré",          desc: "Noter 200 séries",                   cible: 200,  mesure: (b) => b.notees },
  { famille: "Tenue de liste", titre: "Archiviste",    desc: "Créer 5 séries à la main",           cible: 5,    mesure: (b) => b.locales },
  { famille: "Tenue de liste", titre: "Exigeant",      desc: "Mettre la note maximale à 10 séries", cible: 10,  mesure: (b) => b.parfaites },
  { famille: "Tenue de liste", titre: "Sur tous les fronts", desc: "Suivre 5 séries en cours en même temps", cible: 5, mesure: (b) => b.enCours }
];

/* Un palier se lit en entier : « 330 / 1 000 » dit ce qu'il reste à faire,
   « 330 / 1,0 k » oblige à convertir de tête. L'espace insécable évite que le
   nombre se coupe en fin de ligne. */
const chiffre = (n) => n.toLocaleString("fr-FR").replace(/\u202F|\u00A0/g, "\u00A0");

function bilanSucces() {
  const genres = new Set();
  let films = 0, fleuve = 0, parfaites = 0;

  listeCache.forEach((s) => {
    const fini = s.statut === "termine";
    if (fini) (s.genres || []).forEach((g) => genres.add(g));
    if (fini && s.format === "MOVIE") films++;
    if (fini && (s.episodes || 0) >= 100) fleuve++;
    if (s.note && s.note === (s.sur || 10)) parfaites++;
  });

  return {
    termines: listeCache.filter((s) => s.statut === "termine").length,
    enCours:  listeCache.filter((s) => s.statut === "en_cours").length,
    episodes: listeCache.reduce((n, s) => n + (s.vus || 0), 0),
    notees:   listeCache.filter((s) => s.note).length,
    locales:  listeCache.filter((s) => estLocale(s.id)).length,
    genres, films, fleuve, parfaites
  };
}

// Séries AniList dont on ignore encore les genres : celles importées avant.
const sansGenres = () =>
  listeCache.filter((s) => !estLocale(s.id) && !Array.isArray(s.genres));

function afficherSucces() {
  $("succes-invite").hidden  = !!currentUser;
  $("succes-contenu").hidden = !currentUser;
  if (!currentUser) return;

  const b = bilanSucces();
  const manquantes = sansGenres().length;

  $("rattrapage").hidden = manquantes === 0;
  $("rattrapage-texte").textContent =
    `${manquantes} série${manquantes > 1 ? "s" : ""} de ta liste ont été ajoutées avant que le site ne conserve leur genre. ` +
    `Les succès de curiosité restent incomplets tant qu'elles n'ont pas été complétées.`;

  const obtenus = SUCCES.filter((x) => x.mesure(b) >= x.cible).length;
  $("succes-bilan").textContent =
    `${obtenus} succès sur ${SUCCES.length}.`;

  const zone = $("succes-liste");
  zone.innerHTML = "";

  const familles = [...new Set(SUCCES.map((x) => x.famille))];

  familles.forEach((famille) => {
    const titre = document.createElement("h3");
    titre.className = "succes-famille";
    titre.textContent = famille;
    zone.appendChild(titre);

    const grille = document.createElement("div");
    grille.className = "succes-grille";

    SUCCES.filter((x) => x.famille === famille).forEach((x) => {
      const valeur = x.mesure(b);
      const acquis = valeur >= x.cible;
      const part   = Math.min(100, Math.round((valeur / x.cible) * 100));

      const el = document.createElement("article");
      el.className = "succes" + (acquis ? " est-acquis" : "");
      el.innerHTML = `
        <div class="succes-tete">
          <span class="succes-titre">${escapeHtml(x.titre)}</span>
          ${acquis ? `<svg class="succes-coche" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>` : ""}
        </div>
        <p class="succes-desc">${escapeHtml(x.desc)}</p>
        <div class="succes-barre"><span style="width:${part}%"></span></div>
        <p class="succes-compte">${chiffre(Math.min(valeur, x.cible))} / ${chiffre(x.cible)}${
          x.besoinGenres && manquantes ? " · incomplet" : ""}</p>`;
      grille.appendChild(el);
    });

    zone.appendChild(grille);
  });
}

/* Rattrapage des genres : on redemande à AniList, par paquets d'identifiants,
   ce que le site ne conservait pas à l'époque. Une seule fois. */
$("rattrapage-lancer").addEventListener("click", async () => {
  const manquantes = sansGenres();
  if (!manquantes.length || !currentUser) return;

  const bouton = $("rattrapage-lancer");
  bouton.disabled = true;

  try {
    for (let i = 0; i < manquantes.length; i += 50) {
      const paquet = manquantes.slice(i, i + 50);
      bouton.textContent = `Analyse… ${Math.min(i + 50, manquantes.length)} / ${manquantes.length}`;

      const d = await anilist(
        `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { id genres format } } }`,
        { ids: paquet.map((s) => Number(s.id)).filter(Boolean) });

      const trouves = new Map((d.Page?.media || []).map((m) => [String(m.id), m]));
      const lot = writeBatch(db);

      paquet.forEach((s) => {
        const m = trouves.get(s.id);
        lot.set(doc(db, "users", currentUser.uid, "animes", s.id), {
          // Un tableau vide reste une réponse : sans lui, la série serait
          // réanalysée à chaque passage.
          genres: (m?.genres || []).slice(0, 12),
          format: (m?.format || "").slice(0, 20)
        }, { merge: true });
      });
      await lot.commit();

      if (i + 50 < manquantes.length) await pause(1500);
    }
    toast("Ta liste est complétée.");
  } catch (err) {
    console.error("Rattrapage :", err.code, err.message);
    toast("L'analyse s'est interrompue. Relance-la, elle reprendra où elle en est.");
  } finally {
    bouton.disabled = false;
    bouton.textContent = "Compléter ma liste";
    afficherSucces();
  }
});

$("succes-connexion").addEventListener("click", () =>
  ouvrirConnexion("Crée un compte pour suivre tes succès.", "signup"));

/* ══════════════════ Profils publics ══════════════════

   Publier son profil est un choix explicite, et réversible d'un geste.
   Ce que ça expose, littéralement : le pseudo, l'avatar, les compteurs, et la
   liste des séries avec les notes. Rien d'autre — ni adresse e-mail, ni date
   d'inscription, ni les séries abandonnées en silence, puisque tout est dans
   la même liste. C'est dit en clair dans l'interface avant de publier.

   Le mécanisme tient en une phrase : l'existence d'un document dans
   « profilsPublics » vaut autorisation de lecture sur la liste. Les règles
   Firestore la vérifient à chaque requête. Retirer le document referme donc
   la liste dans la seconde, sans avoir à toucher aux séries elles-mêmes.
   ═════════════════════════════════════════════════════ */

let profilPublic   = false;     // mon profil est-il publié ?
let profilsCache   = [];
let profilsCharges = false;
let profilVu       = null;      // profil consulté : { uid, pseudo, avatar, series }
let filtreProfil   = "tous";
let minuteurVitrine;

const compteurs = (liste) => ({
  series:   liste.length,
  episodes: liste.reduce((n, s) => n + (s.vus || 0), 0),
  termines: liste.filter((s) => s.statut === "termine").length
});

async function chargerEtatPublication() {
  profilPublic = false;
  if (!currentUser) return majPublication();
  try {
    profilPublic = (await getDoc(doc(db, "profilsPublics", currentUser.uid))).exists();
  } catch (err) {
    console.error("Profil public :", err.code);
  }
  majPublication();
}

function majPublication() {
  const c = compteurs(listeCache);
  $("publier").textContent = profilPublic ? "Rendre privé" : "Publier mon profil";
  $("publication-etat").textContent = profilPublic
    ? `Visible par les membres : ton pseudo, ton avatar, tes ${c.series} séries et tes notes.`
    : "Ton profil est privé. Personne ne voit ta liste ni tes notes.";
}

/* La vitrine recopie des compteurs déjà calculés côté client : les règles
   n'acceptent que des nombres, donc rien qui puisse servir à afficher un
   texte arbitraire sur une page vue par tout le monde. */
async function ecrireVitrine() {
  if (!currentUser || !profilPublic) return;

  const c = compteurs(listeCache);
  const data = {
    pseudo: $("user-email").textContent || "membre",
    ...c,
    maj: Date.now()
  };
  const avatar = $("user-avatar").hidden ? null : $("user-avatar").src.split("/").pop().replace(".png", "");
  if (avatar && AVATARS.includes(avatar)) data.avatar = avatar;

  try { await setDoc(doc(db, "profilsPublics", currentUser.uid), data); }
  catch (err) { console.error("Vitrine :", err.code, err.message); }
}

/* La liste bouge à chaque épisode coché. On ne réécrit pas la vitrine à chaque
   fois : on attend que ça se calme. */
function planifierVitrine() {
  if (!profilPublic) return;
  clearTimeout(minuteurVitrine);
  minuteurVitrine = setTimeout(ecrireVitrine, 4000);
}

$("publier").addEventListener("click", async () => {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour publier ton profil.", "signup");

  $("publier").disabled = true;
  try {
    if (profilPublic) {
      await deleteDoc(doc(db, "profilsPublics", currentUser.uid));
      profilPublic = false;
      toast("Ton profil est redevenu privé.");
    } else {
      profilPublic = true;
      await ecrireVitrine();
      toast("Ton profil est publié.");
    }
    majPublication();
    profilsCharges = false;
    chargerProfils();
  } catch (err) {
    console.error("Publication :", err.code, err.message);
    profilPublic = !profilPublic;
    toast("L'opération a échoué.");
  } finally {
    $("publier").disabled = false;
  }
});

$("profils-connexion").addEventListener("click", () =>
  ouvrirConnexion("Crée un compte pour voir les profils.", "signup"));

async function chargerProfils() {
  $("profils-invite").hidden  = !!currentUser;
  $("profils-contenu").hidden = !currentUser;
  if (!currentUser || profilsCharges) return;

  profilsCharges = true;
  $("profils-note").textContent = "Chargement…";

  try {
    const snap = await getDocs(collection(db, "profilsPublics"));
    profilsCache = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (b.series || 0) - (a.series || 0));
    afficherProfils();
  } catch (err) {
    console.error("Profils :", err.code, err.message);
    profilsCharges = false;
    $("profils-note").textContent = "Impossible de charger les profils pour l'instant.";
  }
}

function afficherProfils() {
  const zone = $("profils-liste");
  zone.innerHTML = "";

  const moi    = profilsCache.find((p) => p.uid === currentUser?.uid);
  const autres = profilsCache.filter((p) => p.uid !== currentUser?.uid);

  $("profils-note").textContent = autres.length
    ? (autres.length > 1
        ? `${autres.length} membres partagent leur liste.`
        : "1 membre partage sa liste.")
    : "Personne d'autre n'a encore publié son profil.";

  /* Ton propre profil figure dans la liste, en tête et signalé comme tien.
     Le masquer t'empêchait de vérifier ce que les autres voient de toi —
     et c'est précisément ce qu'on veut regarder après avoir publié. */
  const aAfficher = moi ? [moi, ...autres] : autres;

  aAfficher.forEach((p) => {
    const estMoi = p.uid === currentUser?.uid;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "profil-carte" + (estMoi ? " est-moi" : "");

    const avatar = p.avatar && AVATARS.includes(p.avatar)
      ? `<img class="profil-carte-avatar" src="${cheminAvatar(p.avatar)}" alt="" loading="lazy">`
      : `<span class="profil-carte-avatar profil-carte-vide">${escapeHtml(initiales(p.pseudo))}</span>`;

    el.innerHTML = `
      ${avatar}
      <span class="profil-carte-nom">${escapeHtml(p.pseudo || "membre")}${
        estMoi ? `<span class="profil-moi">ton profil</span>` : ""}</span>
      <span class="profil-carte-stats">
        <span><strong>${p.series || 0}</strong> séries</span>
        <span><strong>${nombreCourt(p.episodes || 0)}</strong> épisodes</span>
        <span><strong>${p.termines || 0}</strong> terminées</span>
      </span>`;

    el.addEventListener("click", () => ouvrirProfil(p));
    zone.appendChild(el);
  });
}


/* Aperçu d'une série hors AniList : ce que le membre a saisi, et rien de plus.
   Pas de résumé à inventer, pas de bouton qui ne mènerait nulle part. */
function ouvrirApercu(s) {
  $("apercu-titre").textContent = s.title;

  const avecImage = !!s.cover;
  $("apercu-image").hidden = !avecImage;
  $("apercu-vide").hidden  = avecImage;
  if (avecImage) $("apercu-image").src = s.cover;
  else $("apercu-vide").textContent = initiales(s.title);

  $("apercu-statut").textContent = LIBELLE_STATUT[s.statut] || "—";

  const vus = s.vus || 0;
  $("apercu-episodes").textContent = s.episodes
    ? `${vus} vus sur ${s.episodes}`
    : (vus ? `${vus} vus, total inconnu` : "Non renseigné");

  $("apercu-note").textContent = texteNote(s) || "Pas de note";

  $("apercu-screen").hidden = false;
}

const fermerApercu = () => { $("apercu-screen").hidden = true; };

$("apercu-fermer").addEventListener("click", fermerApercu);
$("apercu-ok").addEventListener("click", fermerApercu);
$("apercu-screen").addEventListener("click", (e) => {
  if (e.target === $("apercu-screen")) fermerApercu();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("apercu-screen").hidden) fermerApercu();
});

async function ouvrirProfil(p) {
  profilVu = { ...p, series_liste: null };
  filtreProfil = "tous";

  $("profil-pseudo").textContent = p.pseudo || "membre";
  $("profil-avatar").hidden = !(p.avatar && AVATARS.includes(p.avatar));
  if (!$("profil-avatar").hidden) $("profil-avatar").src = cheminAvatar(p.avatar);

  $("profil-stats").innerHTML = `
    <p><strong>${p.series || 0}</strong> séries suivies</p>
    <p><strong>${nombreCourt(p.episodes || 0)}</strong> épisodes vus</p>
    <p><strong>${p.termines || 0}</strong> terminées</p>`;

  document.querySelectorAll(".filtre-profil").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.statut === "tous"));

  $("profil-liste").innerHTML = `<p class="loading">Chargement de la liste…</p>`;
  $("profil-vide").hidden = true;
  showView("profil");

  try {
    const snap = await getDocs(collection(db, "users", p.uid, "animes"));
    if (profilVu?.uid !== p.uid) return;         // parti ailleurs entre-temps
    profilVu.series_liste = snap.docs.map((d) => d.data())
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    afficherListeProfil();
  } catch (err) {
    console.error("Liste du profil :", err.code, err.message);
    $("profil-liste").innerHTML =
      `<p class="empty-state">Cette liste n'est plus accessible. Le profil est peut-être redevenu privé.</p>`;
  }
}

function afficherListeProfil() {
  const zone = $("profil-liste");
  const toutes = profilVu?.series_liste || [];
  const vues = trier(
    filtreProfil === "tous" ? toutes : toutes.filter((s) => s.statut === filtreProfil));

  zone.innerHTML = "";
  $("profil-vide").hidden = vues.length > 0;

  vues.forEach((s) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "carte";
    el.innerHTML = `
      <span class="carte-img">
        ${jaquette(s.cover, s.title)}
        ${s.statut === "termine" ? `<span class="carte-bandeau">Terminé</span>` : ""}
      </span>
      <span class="carte-nom">${escapeHtml(s.title)}</span>
      <span class="carte-bas">
        <span class="carte-meta">${LIBELLE_STATUT[s.statut] || ""}</span>
        <span class="carte-note">${texteNote(s)}</span>
      </span>`;

    /* Une série d'un autre membre garde son identifiant AniList : on ouvre sa
       vraie fiche. Une série qu'il a saisie à la main n'existe que chez lui,
       mais elle reste une série de sa liste : elle ouvre un aperçu réduit
       plutôt que de rester inerte au milieu de cartes qui, elles, réagissent. */
    if (estLocale(s.id)) el.__apercu = s;
    else el.__suivi = s;
    zone.appendChild(el);
  });
}

document.querySelectorAll(".filtre-profil").forEach((btn) => {
  btn.addEventListener("click", () => {
    filtreProfil = btn.dataset.statut;
    document.querySelectorAll(".filtre-profil").forEach((b) =>
      b.classList.toggle("is-active", b === btn));
    afficherListeProfil();
  });
});

$("profil-retour").addEventListener("click", () => showView("profils"));

/* ══════════════════ Séries saisies à la main ══════════════════

   AniList ne connaît pas tout : les titres français, les séries confidentielles,
   celles dont l'orthographe résiste. Plutôt que de les perdre, on les crée
   localement. Leur identifiant commence par « local_ », ce qui suffit à savoir
   qu'il ne faut pas aller les chercher en ligne, et qu'elles sont modifiables.
   ══════════════════════════════════════════════════════════════ */

const ID_LOCAL = "local_";
const estLocale = (id) => String(id || "").startsWith(ID_LOCAL);
const nouvelIdLocal = () =>
  ID_LOCAL + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let serieEnEdition = null;   // identifiant en cours de modification, sinon null
let couvertureChoisie = null;

/* Une photo de téléphone pèse plusieurs mégaoctets ; un document Firestore est
   plafonné à un. On redimensionne donc dans le navigateur avant d'enregistrer,
   aux proportions d'une jaquette. */
async function imageReduite(fichier, largeurMax, qualite) {
  const bitmap = await createImageBitmap(fichier, { imageOrientation: "from-image" });
  const ratio = Math.min(1, largeurMax / bitmap.width);
  const l = Math.round(bitmap.width * ratio);
  const h = Math.round(bitmap.height * ratio);

  const toile = document.createElement("canvas");
  toile.width = l; toile.height = h;
  toile.getContext("2d").drawImage(bitmap, 0, 0, l, h);
  bitmap.close?.();
  return toile.toDataURL("image/jpeg", qualite);
}

async function preparerCouverture(fichier) {
  let data = await imageReduite(fichier, 420, 0.72);
  if (data.length > 200000) data = await imageReduite(fichier, 340, 0.6);
  if (data.length > 200000) data = await imageReduite(fichier, 260, 0.5);
  if (data.length > 280000) throw new Error("image-trop-lourde");
  return data;
}

function ouvrirSerie(suivi = null) {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour tenir ta liste.", "signup");

  serieEnEdition = suivi?.id || null;
  couvertureChoisie = suivi?.cover || null;

  $("serie-screen").hidden = false;
  $("serie-titre-fenetre").textContent = suivi ? "Modifier la série" : "Ajouter une série";
  $("serie-valider").textContent = suivi ? "Enregistrer" : "Ajouter à ma liste";

  $("serie-nom").value      = suivi?.title || "";
  $("serie-episodes").value = suivi?.episodes || "";
  $("serie-vus").value      = suivi?.vus ?? 0;
  $("serie-statut").value   = suivi?.statut || "termine";
  $("serie-note").value     = suivi?.note || "";
  $("serie-sur").value      = String(suivi?.sur || echellePreferee);
  $("serie-erreur").hidden  = true;
  $("serie-fichier").value  = "";

  /* Une série liée à AniList voit sa fiche rechargée à chaque ouverture : un
     titre corrigé serait écrasé dans la seconde. La modifier la détache donc
     de la base, définitivement, et c'est assez lourd de conséquence pour être
     annoncé avant plutôt que découvert après. */
  const liee = suivi && !estLocale(suivi.id);
  $("serie-detache").hidden = !liee;

  majApercuCouverture();
  setTimeout(() => $("serie-nom").focus(), 100);
}

function fermerSerie() { $("serie-screen").hidden = true; }

function majApercuCouverture() {
  const img = $("serie-apercu");
  img.hidden = !couvertureChoisie;
  $("serie-sans-image").hidden = !!couvertureChoisie;
  $("serie-retirer-image").hidden = !couvertureChoisie;
  if (couvertureChoisie) img.src = couvertureChoisie;
}

$("ouvrir-serie").addEventListener("click", () => ouvrirSerie());
$("serie-fermer").addEventListener("click", fermerSerie);
$("serie-annuler").addEventListener("click", fermerSerie);
$("serie-screen").addEventListener("click", (e) => {
  if (e.target === $("serie-screen")) fermerSerie();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("serie-screen").hidden) fermerSerie();
});

$("fiche-modifier").addEventListener("click", () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (s) ouvrirSerie(s);
});

$("serie-retirer-image").addEventListener("click", () => {
  couvertureChoisie = null;
  $("serie-fichier").value = "";
  majApercuCouverture();
});

$("serie-fichier").addEventListener("change", async () => {
  const fichier = $("serie-fichier").files?.[0];
  if (!fichier) return;

  $("serie-sans-image").textContent = "Préparation de l'image…";
  try {
    couvertureChoisie = await preparerCouverture(fichier);
    majApercuCouverture();
  } catch (err) {
    console.error("Image :", err);
    toast("Cette image n'a pas pu être préparée. Essaie une autre photo.");
  } finally {
    $("serie-sans-image").textContent = "Aucune image";
  }
});

$("serie-valider").addEventListener("click", async () => {
  const titre = $("serie-nom").value.trim();
  if (titre.length < 1) {
    $("serie-erreur").textContent = "Il faut au moins un titre.";
    $("serie-erreur").hidden = false;
    return $("serie-nom").focus();
  }

  const episodes = Math.min(Math.max(parseInt($("serie-episodes").value, 10) || 0, 0), 5000);
  let vus = Math.min(Math.max(parseInt($("serie-vus").value, 10) || 0, 0), 5000);
  // Le serveur refuse une progression supérieure au total annoncé.
  if (episodes && vus > episodes) vus = episodes;

  const sur = echelleRangee($("serie-sur").value);
  const brute = parseInt($("serie-note").value, 10);
  const note = Number.isInteger(brute) && brute >= 1 ? Math.min(brute, sur) : null;
  echellePreferee = sur;

  const donnees = {
    id: serieEnEdition || nouvelIdLocal(),
    title: titre.slice(0, 300),
    cover: couvertureChoisie || "",
    episodes, vus,
    statut: $("serie-statut").value,
    addedAt: Date.now()
  };
  if (note) { donnees.note = note; donnees.sur = sur; }

  /* Détacher, c'est changer d'identifiant : « local_… » est précisément ce
     qui dit au site de ne plus rien demander à AniList. On recrée donc la
     fiche sous un nouvel identifiant, avec la progression et la note, puis on
     supprime l'ancienne. Deux écritures, jamais de doublon visible. */
  const detache = serieEnEdition && !estLocale(serieEnEdition);
  if (detache) donnees.id = nouvelIdLocal();

  $("serie-valider").disabled = true;
  try {
    const ref = doc(db, "users", currentUser.uid, "animes", donnees.id);

    if (detache) {
      const ancien = listeCache.find((x) => x.id === serieEnEdition);
      donnees.addedAt = ancien?.addedAt || donnees.addedAt;
      await setDoc(ref, donnees);
      await deleteDoc(doc(db, "users", currentUser.uid, "animes", serieEnEdition));
      toast("Série détachée d'AniList et modifiée.");
      if (ficheCourante?.id === serieEnEdition) {
        ficheCourante = depuisSuivi({ ...donnees, note, sur });
        majFiche();
      }
      fermerSerie();
      return;
    }

    if (serieEnEdition) {
      // On garde la date d'ajout d'origine : elle ordonne la liste.
      const ancien = listeCache.find((x) => x.id === serieEnEdition);
      donnees.addedAt = ancien?.addedAt || donnees.addedAt;
      if (!note) { donnees.note = deleteField(); donnees.sur = deleteField(); }
      await updateDoc(ref, donnees);
      toast("Série modifiée.");
      if (ficheCourante?.id === serieEnEdition) {
        ficheCourante = depuisSuivi({ ...donnees, note, sur });
        majFiche();
      }
    } else {
      await setDoc(ref, donnees);
      toast(`${titre} est dans ta liste.`);
    }
    fermerSerie();
  } catch (err) {
    console.error("Série :", err.code, err.message);
    $("serie-erreur").textContent = "L'enregistrement a échoué. L'image est peut-être trop lourde.";
    $("serie-erreur").hidden = false;
  } finally {
    $("serie-valider").disabled = false;
  }
});

/* ══════════════════ Import d'une liste ══════════════════

   Beaucoup de gens tiennent déjà leur liste ailleurs : les notes du
   téléphone, un carnet, un tableur. Retaper trois cents titres un par un
   n'aurait aucun sens. On colle le texte, le site cherche chaque titre sur
   AniList, on vérifie ce qu'il a reconnu, et tout part d'un coup.

   L'étape de vérification n'est pas une politesse : une recherche par
   titre approximatif se trompe forcément quelques fois, et personne ne veut
   découvrir après coup vingt séries qu'il n'a jamais regardées dans sa liste.
   ════════════════════════════════════════════════════════ */

let importEntrees = [];
let importOccupe  = false;
let importEchecs  = 0;

/* Réduit un titre à sa forme comparable : sans casse, sans accents, sans
   ponctuation. « Re:ZERO -Starting Life- » et « Re Zero Starting Life »
   deviennent alors la même chaîne. */
const cleTitre = (s) => String(s || "")
  .toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

/* La note est ramenée à l'échelle choisie, pas systématiquement sur 10 :
   un 17/20 reste un 17/20. Passer par 10 écraserait 17 et 18 sur la même
   valeur, et 19 et 20 aussi. */
let echelleImport = 20;

const surEchelle = (valeur, max) =>
  (!Number.isFinite(valeur) || !max)
    ? null
    : Math.min(echelleImport, Math.max(1, Math.round((valeur / max) * echelleImport)));

/* Une liste tenue dans les notes du téléphone est pleine d'annotations
   personnelles : « (attente saison 2) », « (ost : sparkle) », « arrêt épisode
   7 ». Elles arrivent aussi bien avant qu'après la note, et n'ont rien à faire
   dans une recherche. Tout ce qui est entre parenthèses part donc au panier. */
function nettoyerTitre(t) {
  return String(t)
    .replace(/\([^)]*\)?/g, " ")          // commentaires, même parenthèse jamais refermée
    .replace(/\[[^\]]*\]?/g, " ")
    .replace(/[.\u2026]{2,}/g, " ")       // « ... » et « … » de troncature
    .replace(/\u2026/g, " ")
    .replace(/^[\s\-\u2013\u2014•*·>+]+/, "")
    .replace(/^\d{1,3}\s*[.)]\s+/, "")    // numérotation « 12. »
    .replace(/[\s\-\u2013\u2014:;,|.\/)\]]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Un titre doit contenir des lettres : « 3) » ou « 2020 » sont des résidus.
const aDuTexte = (t) => /[a-zA-Z\u00C0-\u024F]{2}/.test(t);

const creerEntree = (titre, note, brut) =>
  ({ titre, note, brut: brut.trim(), garder: true, candidats: [], choix: null, sur: 0 });

/* Une note écrite « 18/20 » est reconnaissable n'importe où dans la ligne :
   son dénominateur ne laisse aucun doute. C'est ce qui permet de récupérer
   « sword art online 20/20 (suite 12 octobre) », où la note est au milieu. */
const RE_FRACTION = /(\d{1,3}(?:[.,]\d+)?)\s*\/\s*(\d{1,3})/g;

function analyserLigne(ligne, echelle) {
  const source = String(ligne).trim();
  if (!source) return [];

  const fractions = [...source.matchAll(RE_FRACTION)]
    .filter((m) => Number(m[2]) >= 3 && Number(m[2]) <= 100);

  if (!fractions.length) {
    const seule = sansFraction(source, echelle);
    return seule ? [seule] : [];
  }

  /* Deux notes sur une ligne, c'est deux séries qu'un retour à la ligne
     manquant a collées ensemble. Chaque note ferme le titre qui la précède. */
  const entrees = [];
  let debut = 0;

  fractions.forEach((m) => {
    const titre = nettoyerTitre(source.slice(debut, m.index));
    debut = m.index + m[0].length;
    if (!titre || !aDuTexte(titre)) return;
    entrees.push(creerEntree(
      titre,
      surEchelle(parseFloat(m[1].replace(",", ".")), Number(m[2])),
      source
    ));
  });

  return entrees;
}

/* Sans dénominateur, le piège ce sont les titres qui finissent par un
   chiffre : « Steins;Gate 0 », « Mob Psycho 100 », « 86 ». D'où les
   garde-fous — séparateur obligatoire, note dans l'échelle choisie, et titre
   restant non vide. */
function sansFraction(source, echelle) {
  let reste = source;
  let note = null;

  // « Naruto (8) » : une parenthèse qui ne contient qu'un nombre est une note.
  const entreParentheses = source.match(/[(\[](\d{1,2}(?:[.,]\d+)?)[)\]]\s*$/);

  if (entreParentheses) {
    const valeur = parseFloat(entreParentheses[1].replace(",", "."));
    if (valeur >= 1 && valeur <= echelle) {
      note  = surEchelle(valeur, echelle);
      reste = source.slice(0, entreParentheses.index);
    }
  } else {
    reste = source.replace(/\([^)]*\)?/g, " ").replace(/\[[^\]]*\]?/g, " ");
    const nue = reste.match(/[-\s:;=|\u2013\u2014]\s*(\d{1,2}(?:[.,]\d+)?)\s*$/);
    if (nue) {
      const valeur = parseFloat(nue[1].replace(",", "."));
      const avant  = nettoyerTitre(reste.slice(0, nue.index));
      if (valeur >= 1 && valeur <= echelle && avant.length >= 2) {
        note  = surEchelle(valeur, echelle);
        reste = avant;
      }
    }
  }

  const titre = nettoyerTitre(reste);
  return titre && aDuTexte(titre) ? creerEntree(titre, note, source) : null;
}

/* Deuxième chance pour les titres restés sans résultat. « saekano/how to
   raise a boring girlfriend » ou « hell mode : the hardcore gamer » sont deux
   titres accolés : le premier morceau suffit presque toujours. */
function variante(titre) {
  const coupe = titre.split(/\s*[\/:|]\s*/)[0].trim();
  if (coupe.length >= 3 && coupe !== titre) return coupe;

  const mots = titre.split(/\s+/);
  if (mots.length > 4) return mots.slice(0, 4).join(" ");
  return null;
}

/* Champs réduits au strict nécessaire : la vérification n'affiche qu'une
   vignette et un titre, et une requête groupée en demande quarante d'un coup. */
const CHAMPS_IMPORT = `
  id
  title { romaji english native }
  synonyms
  coverImage { large }
  episodes
  format
  genres
  seasonYear
`;

/* Une requête par titre serait interminable et se ferait limiter par AniList.
   GraphQL permet d'aliaser plusieurs recherches dans un même appel : douze
   titres partent ensemble, ce qui ramène une liste de trois cents séries à
   une trentaine d'appels. */
const LOT = 12;

function requeteLot(titres) {
  const variables = titres.map((_, i) => `$q${i}: String`).join(", ");
  const blocs = titres.map((_, i) => `
    r${i}: Page(perPage: 4) {
      media(type: ANIME, search: $q${i}, isAdult: false) { ${CHAMPS_IMPORT} }
    }`).join("");
  return `query (${variables}) { ${blocs} }`;
}

const simplifier = (m) => ({
  id:       String(m.id),
  title:    m.title?.english || m.title?.romaji || "Sans titre",
  cover:    m.coverImage?.large || "",
  episodes: m.episodes || 0,
  format:   m.format || "",
  annee:    m.seasonYear || null,
  noms:     [m.title?.romaji, m.title?.english, m.title?.native, ...(m.synonyms || [])]
              .filter(Boolean).map(cleTitre)
});

/* Combien on peut faire confiance à un résultat. Zéro veut dire qu'aucun des
   noms de la série ne ressemble à ce qui était écrit : c'est le cas des
   titres en français, qu'AniList ne connaît pas. Ces lignes-là arrivent
   décochées, pour qu'une série jamais regardée n'entre pas dans la liste. */
/* Le rapprochement se faisait sur un simple « commence par » ou « contient »,
   sans regarder les longueurs. « nana » acceptait donc « nanatsu no taizai »,
   et « parasite » n'importe quel titre débutant de même : une série jamais
   regardée entrait dans la liste sous un nom crédible.

   Deux garde-fous désormais. Un rapport de longueurs : un titre trois fois
   plus long que le tien n'est pas le tien. Et une proportion de mots communs,
   qui rattrape les orthographes flottantes — « kimetsu no yaiba/demon slayer »
   partage assez de mots avec « Kimetsu no Yaiba » pour rester sûr, quand
   « nana » n'en partage aucun avec « nanatsu no taizai ». */
function confiance(media, cle) {
  const motsA = cle.split(" ").filter(Boolean);
  let meilleur = 0;

  for (const n of media.noms) {
    if (!n) continue;
    if (n === cle) return 3;

    const rapport = Math.min(n.length, cle.length) / Math.max(n.length, cle.length);

    const motsB = n.split(" ").filter(Boolean);
    const communs = motsA.filter((m) => motsB.includes(m)).length;
    const recouvrement = (2 * communs) / (motsA.length + motsB.length);

    let score = 0;
    if ((n.startsWith(cle) || cle.startsWith(n)) && rapport >= 0.6) score = 2;
    else if (recouvrement >= 0.7) score = 2;
    else if ((n.includes(cle) || cle.includes(n)) && rapport >= 0.5) score = 1;
    else if (recouvrement >= 0.5) score = 1;

    meilleur = Math.max(meilleur, score);
  }
  return meilleur;
}

function classer(entree) {
  const cle = cleTitre(entree.titre);
  let meilleur = null, meilleurSur = -1;

  // À score égal on garde l'ordre d'AniList : sa pertinence vaut mieux qu'un
  // départage arbitraire de notre part.
  entree.candidats.forEach((c) => {
    const s = confiance(c, cle);
    if (s > meilleurSur) { meilleur = c; meilleurSur = s; }
  });

  entree.choix  = meilleur;
  entree.sur    = Math.max(meilleurSur, 0);
  // Une correspondance douteuse est décochée : mieux vaut une série absente
  // qu'une série jamais regardée dans la liste. Une absence totale de résultat,
  // en revanche, part en création manuelle — le titre, lui, est certain.
  // Il faut désormais une correspondance franche pour être coché d'office.
  // Le reste attend ton avis plutôt que d'entrer dans ta liste en douce.
  entree.garder = meilleur ? meilleurSur >= 2 : true;
}

async function interrogerLot(titres) {
  const variables = Object.fromEntries(titres.map((t, i) => [`q${i}`, t]));
  const data = await anilist(requeteLot(titres), variables, {
    onAttente: (s) => {
      $("import-etat").textContent =
        `AniList limite le rythme des recherches. Reprise dans ${s} secondes…`;
    }
  });
  $("import-etat").textContent = "Recherche des séries sur AniList…";
  return titres.map((_, i) => (data[`r${i}`]?.media || []).map(simplifier));
}

/* Trois cents lignes, c'est une trentaine d'allers-retours réseau. Sur un
   téléphone qui change d'antenne, ou face à une coupure de rythme d'AniList,
   il y en aura un qui échouera — et faire échouer l'import entier pour lui
   revenait à jeter vingt-cinq requêtes réussies. Chaque paquet est donc isolé :
   il retente une fois, puis abandonne seul. Les lignes concernées ressortent
   simplement comme non trouvées, donc créées à la main, donc pas perdues. */
async function chercherLot(entrees, avancement) {
  let echecs = 0;

  async function traiter(paquet, titres) {
    for (let tentative = 0; tentative < 2; tentative++) {
      try {
        return await interrogerLot(titres);
      } catch (err) {
        console.warn("Paquet en échec :", err.message);
        if (tentative === 0) {
          $("import-etat").textContent = "Connexion difficile, nouvelle tentative…";
          await pause(4000);
        }
      }
    }
    echecs += paquet.length;
    $("import-etat").textContent = "Recherche des séries sur AniList…";
    return null;
  }

  for (let i = 0; i < entrees.length; i += LOT) {
    const paquet = entrees.slice(i, i + LOT);
    const reponses = await traiter(paquet, paquet.map((e) => e.titre));

    if (reponses) paquet.forEach((e, j) => { e.candidats = reponses[j]; classer(e); });
    else paquet.forEach((e) => { e.echec = true; e.candidats = []; classer(e); });

    avancement(Math.min(i + LOT, entrees.length));
    if (i + LOT < entrees.length) await pause(2000);
  }

  importEchecs = echecs;

  /* Seconde chance : les titres restés bredouilles repartent sous une forme
     raccourcie. « saekano/how to raise a boring girlfriend » ne donne rien,
     « saekano » donne la bonne série. */
  const bredouilles = entrees
    .map((e) => ({ e, autre: e.candidats.length ? null : variante(e.titre) }))
    .filter((x) => x.autre);

  for (let i = 0; i < bredouilles.length; i += LOT) {
    const paquet = bredouilles.slice(i, i + LOT);
    $("import-etat").textContent = "Nouvel essai sur les titres non trouvés…";
    const reponses = await traiter(paquet, paquet.map((x) => x.autre));
    if (!reponses) continue;

    paquet.forEach((x, j) => {
      if (!reponses[j].length) return;
      x.e.candidats = reponses[j];
      classer(x.e);
    });

    if (i + LOT < bredouilles.length) await pause(2000);
  }
}

/* ── Fenêtre ── */

function etapeImport(nom) {
  $("import-saisie").hidden    = nom !== "saisie";
  $("import-analyse").hidden   = nom !== "analyse";
  $("import-resultats").hidden = nom !== "resultats";
}

function ouvrirImport() {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour importer ta liste.");
  $("import-screen").hidden = false;
  etapeImport("saisie");
  setTimeout(() => $("import-texte").focus(), 100);
}

function fermerImport() {
  if (importOccupe) return;   // une écriture en cours ne se referme pas à moitié
  $("import-screen").hidden = true;
}

$("ouvrir-import").addEventListener("click", ouvrirImport);
$("import-fermer").addEventListener("click", fermerImport);
$("import-annuler").addEventListener("click", fermerImport);
$("import-retour").addEventListener("click", () => etapeImport("saisie"));

$("import-screen").addEventListener("click", (e) => {
  if (e.target === $("import-screen")) fermerImport();
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("import-screen").hidden) fermerImport();
});

$("import-analyser").addEventListener("click", async () => {
  const echelle = Number($("import-echelle").value) || 10;

  echelleImport = echelleRangee(echelle);
  importEchecs  = 0;

  const entrees = $("import-texte").value
    .split("\n").flatMap((l) => analyserLigne(l, echelle));

  if (!entrees.length) return toast("Colle d'abord ta liste, une série par ligne.");
  if (entrees.length > 500) return toast("500 séries au maximum en une fois.");

  importEntrees = entrees;
  importOccupe  = true;
  etapeImport("analyse");
  progressionImport(0, entrees.length);

  try {
    await chercherLot(entrees, (fait) => progressionImport(fait, entrees.length));
    afficherResultatsImport();
    etapeImport("resultats");
  } catch (err) {
    /* On arrive ici pour une panne franche — plus de réseau du tout. Le texte
       collé reste intact dans le champ, il n'y a rien à retaper. */
    console.error("Import :", err);
    etapeImport("saisie");
    $("import-etat").textContent = "Recherche des séries sur AniList…";
    toast(`Recherche interrompue : ${err.message}. Ton texte est intact, réessaie.`);
  } finally {
    importOccupe = false;
  }
});

function progressionImport(fait, total) {
  $("import-barre").style.width = `${total ? Math.round((fait / total) * 100) : 0}%`;

  // Le rythme est bridé pour ne pas se faire couper par AniList : autant
  // annoncer l'attente plutôt que de laisser une barre avancer en silence.
  const restant = Math.ceil(((total - fait) / LOT) * 2);
  $("import-compteur").textContent =
    `${fait} série${fait > 1 ? "s" : ""} sur ${total}`
    + (restant > 5 ? ` — encore ${restant} secondes environ` : "");
}

function afficherResultatsImport() {
  const zone = $("import-lignes");
  zone.innerHTML = "";

  importEntrees.forEach((e) => zone.appendChild(ligneImport(e)));
  bilanImport();
}

/* Une ligne de vérification. Tout y est modifiable : la série retenue, la
   note, et la recherche elle-même — sans quoi les titres qu'AniList ne
   reconnaît pas seraient perdus, et il y en a toujours. */
function ligneImport(e) {
  const ligne = document.createElement("div");
  ligne.className = "import-ligne";

  const coche = document.createElement("input");
  coche.type = "checkbox";
  coche.setAttribute("aria-label", "Importer cette série");
  coche.addEventListener("change", () => {
    e.garder = coche.checked;
    bilanImport();
  });

  const vignette = document.createElement("img");
  vignette.className = "import-vignette";
  vignette.alt = ""; vignette.loading = "lazy"; vignette.referrerPolicy = "no-referrer";

  const vide = document.createElement("span");
  vide.className = "import-vide";
  vide.textContent = "?";

  const infos  = document.createElement("div");
  infos.className = "import-infos";
  const titre  = document.createElement("p");
  titre.className = "import-titre";
  const source = document.createElement("p");
  source.className = "import-source";
  const alt = document.createElement("select");
  alt.className = "import-alt";
  alt.setAttribute("aria-label", "Choisir une autre série");

  const note = document.createElement("input");
  note.type = "number";
  note.className = "import-note";
  note.min = 0; note.step = 1;
  note.placeholder = "—";
  note.setAttribute("aria-label", "Ta note");
  note.addEventListener("change", () => {
    const v = Math.round(Number(note.value));
    e.note = Number.isInteger(v) && v >= 1 && v <= echelleImport ? v : null;
    note.value = e.note ?? "";
  });

  // Recherche manuelle, repliée tant qu'on n'en a pas besoin.
  const relance = document.createElement("button");
  relance.type = "button";
  relance.className = "btn-link import-relance";
  relance.textContent = "Chercher un autre titre";

  const boite = document.createElement("div");
  boite.className = "import-recherche";
  boite.hidden = true;
  const champ = document.createElement("input");
  champ.type = "search";
  champ.setAttribute("aria-label", "Chercher un autre titre");
  const go = document.createElement("button");
  go.type = "button";
  go.className = "btn-ghost";
  go.textContent = "Chercher";
  boite.append(champ, go);

  relance.addEventListener("click", () => {
    boite.hidden = !boite.hidden;
    if (!boite.hidden) { champ.value = e.titre; champ.focus(); }
  });

  const lancer = async () => {
    const terme = champ.value.trim();
    if (terme.length < 2 || importOccupe) return;
    go.disabled = true; go.textContent = "…";
    try {
      const [resultats] = await interrogerLot([terme]);
      if (resultats.length) {
        e.titre = terme;
        e.candidats = resultats;
        classer(e);
        boite.hidden = true;
        peindre();
        bilanImport();
      } else {
        toast(`Rien trouvé pour « ${terme} ».`);
      }
    } catch (err) {
      toast("Recherche impossible pour le moment.");
    } finally {
      go.disabled = false; go.textContent = "Chercher";
    }
  };

  go.addEventListener("click", lancer);
  champ.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); lancer(); } });

  /* Redessine la ligne à partir de l'état de l'entrée : le même code sert au
     premier affichage et après une recherche manuelle. */
  function peindre() {
    const trouve = !!e.choix;
    ligne.classList.toggle("est-introuvable", !trouve);
    ligne.classList.toggle("est-douteuse", trouve && e.sur < 2);

    coche.checked  = e.garder;
    coche.disabled = false;      // même sans jaquette, la série est importable
    note.value     = e.note ?? "";
    note.max       = echelleImport;

    vignette.hidden = !trouve;
    vide.hidden     = trouve;
    if (trouve) vignette.src = e.choix.cover;

    const deja = trouve && listeCache.some((s) => s.id === e.choix.id);

    titre.textContent = trouve ? e.choix.title : e.titre;
    source.className  = "import-source" + (deja ? " import-deja" : "");
    source.textContent = deja
      ? "Déjà dans ta liste — ta progression sera conservée"
      : e.echec
        ? "Recherche impossible — créée sans jaquette, modifiable ensuite"
      : !trouve
        ? "Inconnue d'AniList — créée sans jaquette, modifiable ensuite"
        : (e.sur < 2 ? `Correspondance incertaine · ta ligne : ${e.brut}` : `Ta ligne : ${e.brut}`);

    alt.hidden = !e.candidats.length;
    if (!alt.hidden) {
      alt.innerHTML = "";
      e.candidats.forEach((c, i) => {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = c.title + (c.annee ? ` (${c.annee})` : "");
        opt.selected = trouve && c.id === e.choix.id;
        alt.appendChild(opt);
      });
      /* Quand aucune proposition ne convient, on refuse le rapprochement
         plutôt que d'en accepter un mauvais : la série est créée sous ton
         propre titre, modifiable ensuite. */
      const perso = document.createElement("option");
      perso.value = "local";
      perso.textContent = `Aucune — créer « ${e.titre} » sans jaquette`;
      perso.selected = !trouve;
      alt.appendChild(perso);
    }
  }

  alt.addEventListener("change", () => {
    if (alt.value === "local") {
      e.choix = null;             // création locale forcée
      e.sur = 0;
    } else {
      e.choix = e.candidats[Number(alt.value)];
      e.sur = Math.max(e.sur, 2); // un choix explicite n'est plus une supposition
    }
    peindre();
    bilanImport();
  });

  /* La ligne est une grille : jaquette à gauche, titre et case en haut, puis
     la source et les commandes dessous. Sur téléphone, tout tient sans que le
     titre soit rogné à trois mots. */
  const outils = document.createElement("div");
  outils.className = "import-outils";
  outils.append(note, alt, relance, boite);

  infos.append(titre);
  ligne.append(coche, vignette, vide, infos, source, outils);
  peindre();
  return ligne;
}

function bilanImport() {
  const trouvees    = importEntrees.filter((e) => e.choix).length;
  const cochees     = importEntrees.filter((e) => e.garder).length;
  const douteuses   = importEntrees.filter((e) => e.choix && e.sur === 0).length;
  const introuvable = importEntrees.length - trouvees;

  const bouts = [`${cochees} série${cochees > 1 ? "s" : ""} cochée${cochees > 1 ? "s" : ""} sur ${importEntrees.length} lignes lues`];
  if (introuvable) bouts.push(`${introuvable} créée${introuvable > 1 ? "s" : ""} à la main, sans jaquette`);
  if (importEchecs) bouts.push(`${importEchecs} non vérifiée${importEchecs > 1 ? "s" : ""} faute de réseau`);
  if (douteuses)   bouts.push(`${douteuses} incertaine${douteuses > 1 ? "s" : ""}, décochée${douteuses > 1 ? "s" : ""} par précaution`);

  $("import-bilan").textContent =
    `${bouts.join(" · ")}. Vérifie, corrige ce qui doit l'être, puis valide.`;
  $("import-valider").disabled = cochees === 0;
  $("import-tout").textContent  = cochees === 0 ? "Tout cocher" : "Tout décocher";
}

$("import-tout").addEventListener("click", () => {
  const cocher = importEntrees.filter((e) => e.garder).length === 0;
  importEntrees.forEach((e) => { e.garder = cocher; });
  $("import-lignes").querySelectorAll("input[type=checkbox]").forEach((c) => {
    c.checked = cocher;
  });
  bilanImport();
});

$("import-valider").addEventListener("click", async () => {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour importer ta liste.");

  const statut = $("import-statut").value;
  const uid = currentUser.uid;

  /* Une même série peut apparaître deux fois dans le texte collé, ou deux
     lignes différentes peuvent tomber sur le même titre. */
  /* Repasser deux fois la même liste ne doit rien dupliquer. Une série
     reconnue se reconnaît à son identifiant AniList ; une série créée à la
     main n'en a pas, on la rapproche donc par son titre normalisé — c'est le
     seul point commun entre deux imports du même fichier. */
  const localesExistantes = new Map(
    listeCache.filter((s) => estLocale(s.id)).map((s) => [cleTitre(s.title), s.id])
  );

  const vus = new Set();
  const retenues = importEntrees.filter((e) => {
    if (!e.garder) return false;
    const cle = e.choix ? e.choix.id : "titre:" + cleTitre(e.titre);
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });

  if (!retenues.length) return toast("Rien de coché.");

  importOccupe = true;
  $("import-valider").disabled = true;
  $("import-valider").textContent = "Enregistrement…";

  /* Une écriture par série serait lente et bruyante. Firestore accepte 500
     opérations par lot ; on découpe large pour rester à l'aise. */
  const OPS = 400;
  const operations = [];

  /* Trois cents séries écrites en un lot partagent la même milliseconde :
     l'ordre du fichier serait perdu, et « ordre d'ajout » afficherait un
     classement arbitraire. On écarte donc les horodatages d'un millième de
     seconde chacun, dans l'ordre où les lignes ont été collées. */
  const instant = Date.now();
  const reordonner = $("import-reordonner").checked;

  retenues.forEach((e, rangEntree) => {
    /* Sans correspondance AniList, la série est créée telle qu'elle était
       écrite : titre seul, sans jaquette, modifiable depuis sa fiche. Si un
       import précédent l'a déjà créée, on reprend son identifiant au lieu
       d'en fabriquer un second. */
    const cleLocale = cleTitre(e.titre);
    const m = e.choix || {
      id: localesExistantes.get(cleLocale) || nouvelIdLocal(),
      title: e.titre, cover: "", episodes: 0
    };
    if (!e.choix) localesExistantes.set(cleLocale, m.id);
    const episodes = Math.min(Math.max(m.episodes || 0, 0), 5000);
    const dejaSuivie = listeCache.find((s) => s.id === m.id);

    const data = {
      id: m.id,
      title: m.title.slice(0, 300),
      cover: (m.cover || "").slice(0, 500),
      episodes,
      vus: statut === "termine" ? episodes : 0,
      statut,
      addedAt: instant + rangEntree,
      genres: (m.genres || []).slice(0, 12),
      format: (m.format || "").slice(0, 20)
    };

    // La note accompagne la série : elle reste personnelle et n'entre dans
    // aucune moyenne. Une série déjà suivie garde sa progression, mais reçoit
    // quand même la note du fichier.
    if (e.note) { data.note = e.note; data.sur = echelleImport; }

    if (dejaSuivie) {
      /* Une série déjà suivie n'est jamais réécrite : sa progression, ses
         images et ses corrections valent mieux que ce que dit le fichier.
         Seules la note et, si tu l'as demandé, sa place dans l'ordre. */
      const retouche = {};
      if (e.note) { retouche.note = e.note; retouche.sur = echelleImport; }
      if (reordonner) retouche.addedAt = instant + rangEntree;

      if (!Object.keys(retouche).length) return;
      operations.push({
        ref: doc(db, "users", uid, "animes", m.id),
        data: retouche,
        fusion: true
      });
      return;
    }

    operations.push({ ref: doc(db, "users", uid, "animes", m.id), data });
  });

  try {
    for (let i = 0; i < operations.length; i += OPS) {
      const lot = writeBatch(db);
      operations.slice(i, i + OPS).forEach((o) => lot.set(o.ref, o.data, { merge: !!o.fusion }));
      await lot.commit();
    }

    $("import-screen").hidden = true;
    $("import-texte").value = "";
    toast(reordonner
      ? `${retenues.length} série${retenues.length > 1 ? "s" : ""} enregistrée${retenues.length > 1 ? "s" : ""}, ta liste suit l'ordre du fichier.`
      : `${retenues.length} série${retenues.length > 1 ? "s" : ""} ajoutée${retenues.length > 1 ? "s" : ""} à ta liste.`);
  } catch (err) {
    console.error("Import :", err.code, err.message);
    toast("L'enregistrement a échoué. Réessaie dans un instant.");
  } finally {
    importOccupe = false;
    $("import-valider").disabled = false;
    $("import-valider").textContent = "Ajouter à ma liste";
  }
});

/* ══════════════════ Fiche ══════════════════ */

function ouvrirFiche(a) {
  ficheCourante = a;
  majFiche();
  showView("fiche");
}

function majFiche() {
  const a = ficheCourante;
  if (!a) return;
  const suivi = listeCache.find((s) => s.id === a.id);

  $("fiche-cover").hidden = !a.cover;
  $("fiche-cover-vide").hidden = !!a.cover;
  if (a.cover) $("fiche-cover").src = a.cover;
  else $("fiche-cover-vide").textContent = initiales(a.title);
  $("fiche-titre").textContent = a.title;

  const bouts = [FORMATS[a.format] || a.format, a.studio,
                 a.episodes ? `${a.episodes} épisodes` : null,
                 a.locale ? "Ajoutée par toi" : dateDebut(a)];
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

  afficherPlateformes(a.liens);
  afficherNotePerso(suivi);
  $("fiche-modifier").hidden = !suivi;

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
      addedAt: Date.now(),
      // Conservés pour les succès : les redemander série par série coûterait
      // une requête réseau par jaquette.
      genres: (a.genres || []).slice(0, 12),
      format: (a.format || "").slice(0, 20)
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

/* ══════════════════ Notes personnelles ══════════════════

   Les notes vivaient dans une collection publique, et chaque note alimentait
   une moyenne visible de tous. Elles sont désormais rangées dans la fiche de
   suivi de chacun : personne d'autre ne les voit, et ta liste n'influence plus
   ce qu'affiche le site aux autres.

   Effet de bord appréciable : la moyenne demandait une requête d'agrégation
   par jaquette entrant à l'écran. Avec trois cents séries, faire défiler sa
   liste déclenchait trois cents requêtes. La note est maintenant déjà là,
   dans les données de la liste, et ne coûte plus rien.

   L'échelle est enregistrée avec la note. Un 17 saisi sur 20 se réaffiche
   « 17/20 », pas « 9/10 » : convertir, c'est perdre la moitié des nuances.
   ════════════════════════════════════════════════════════ */

const ECHELLES = [10, 20];

// L'échelle de saisie peut être sur 5 ; on la range sur 10, qui la contient.
const echelleRangee = (e) => (Number(e) === 20 ? 20 : 10);

const convertirNote = (valeur, depuis, vers) =>
  Math.min(vers, Math.max(1, Math.round((valeur / depuis) * vers)));

const texteNote = (s) => (s && s.note ? `${s.note}/${s.sur || 10}` : "");

/* Dernière échelle utilisée, retenue le temps de la session : qui note sur 20
   note sur 20 pour toutes ses séries, et n'a pas à le redire à chaque fiche. */
let echellePreferee = 20;

function afficherPlateformes(liens) {
  const bloc = $("fiche-plateformes");
  bloc.hidden = !liens?.length;
  if (bloc.hidden) return;

  const zone = $("fiche-liens");
  zone.innerHTML = "";

  liens.forEach((l) => {
    const a = document.createElement("a");
    a.className = "plateforme" + (l.fr ? " est-fr" : "");
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.innerHTML = `<span>${escapeHtml(l.site)}</span>` +
      (l.fr ? `<span class="plateforme-fr">français</span>` : "");
    zone.appendChild(a);
  });

  const enFrancais = liens.filter((l) => l.fr).length;
  $("plateformes-note").textContent = enFrancais
    ? "Les plateformes marquées « français » proposent la série en français, sans qu'AniList précise s'il s'agit de la VF ou de la VOSTFR."
    : "Aucune plateforme francophone référencée pour cette série. Ces liens sont tenus par la communauté AniList et peuvent être incomplets.";
}

function afficherNotePerso(suivi) {
  const bloc = $("fiche-note-bloc");
  bloc.hidden = !suivi;
  if (!suivi) return;

  const sur = suivi.sur || echellePreferee;

  $("fiche-note").textContent = suivi.note
    ? `${suivi.note} sur ${sur}`
    : "Pas encore notée";

  document.querySelectorAll(".echelle").forEach((b) =>
    b.classList.toggle("is-active", Number(b.dataset.sur) === sur));

  const zone = $("fiche-notes");
  zone.innerHTML = "";

  for (let i = 1; i <= sur; i++) {
    const atteint = suivi.note && i <= suivi.note;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "note-btn" + (atteint ? " is-atteint" : "") + (suivi.note === i ? " is-active" : "");
    b.textContent = i;
    b.setAttribute("aria-pressed", String(suivi.note === i));
    // Recliquer sur sa propre note l'efface : c'est le seul moyen de revenir
    // à « pas notée » sans inventer un bouton de plus.
    b.addEventListener("click", () => noter(suivi.id, suivi.note === i ? null : i, sur));
    zone.appendChild(b);
  }

  const info = document.createElement("span");
  info.className = "note-mienne";
  info.textContent = suivi.note
    ? "Clique à nouveau sur ta note pour l'effacer"
    : "Personne d'autre ne voit tes notes";
  zone.appendChild(info);
}

async function noter(id, valeur, sur) {
  if (!currentUser) return;
  echellePreferee = sur;
  try {
    await majSuivi(id, valeur === null
      ? { note: deleteField(), sur: deleteField() }
      : { note: valeur, sur });
  } catch (err) {
    console.error("Note :", err.code, err.message);
    toast("La note n'a pas pu être enregistrée.");
  }
}

/* Changer d'échelle reporte la note au prorata : 17/20 devient 9/10. La
   conversion perd de la finesse dans ce sens, jamais dans l'autre. */
document.querySelectorAll(".echelle").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const s = listeCache.find((x) => x.id === ficheCourante?.id);
    if (!s) return;
    const sur = Number(btn.dataset.sur);
    echellePreferee = sur;
    if (!s.note) { afficherNotePerso({ ...s, sur }); return; }
    await majSuivi(s.id, { note: convertirNote(s.note, s.sur || 10, sur), sur });
  });
});

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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

