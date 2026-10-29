/* Suivi des visites — à copier à la racine de chaque site suivi par le tableau de bord.
 *
 * Installation dans un site : copier ce fichier à la racine du site, puis ajouter dans chaque page
 *   <script src="suivi.js" data-site="nom-du-site" data-base="https://….firebasedatabase.app" defer></script>
 * (avec le bon chemin, par exemple ../suivi.js dans un sous-dossier). « nom-du-site » : 2 à 30
 * caractères parmi a-z, 0-9 et « - ». data-base : adresse de la Realtime Database du site, où ranger
 * les chiffres. Cette base doit avoir les règles « stats » (voir regles-stats.txt du tableau de bord).
 *
 * Rien de personnel n'est envoyé : pas d'adresse IP enregistrée, pas d'identifiant. Chaque appareil
 * retient seulement (dans son navigateur) le jour et le mois où il a déjà été compté, pour compter
 * chaque visiteur une fois par jour et par mois. La base ne reçoit que des compteurs :
 *
 *   stats/<site>/jours/AAAA-MM-JJ   visiteurs, vues, nouveaux, appli, appareils/{mobile|ordi},
 *                                   pages/<page> (visiteurs du jour par page)
 *   stats/<site>/mois/AAAA-MM       visiteurs
 *   stats/<site>/total              visiteurs, vues
 *
 * <page> = premier dossier de l'adresse sous la racine du site (« uno » pour /uno/), ou « accueil ».
 * La racine du site est le dossier qui contient ce fichier. Pour un site d'une seule page à onglets :
 *   - data-page="carte" sur la balise donne le nom de la page affichée à l'ouverture ;
 *   - window.suivi.page('itineraires') compte le passage sur un autre onglet (une page vue de plus,
 *     et un visiteur de plus pour cet onglet s'il ne l'avait pas encore ouvert ce jour-là).
 *
 * Actions : window.suivi.action('parties-en-ligne', 'uno') ajoute 1 à
 *   stats/<site>/jours/AAAA-MM-JJ/actions/<action>/<page>   et   stats/<site>/total/actions/<action>/<page>
 * (une partie lancée, un formulaire envoyé…). Sans <page> : la page actuelle. Le tableau de bord affiche
 * les actions dont le nom commence par « parties » comme des parties jouées, avec le détail par mode.
 *
 * Pas compté : localhost, hors connexion, et un appareil où l'on a ouvert le site avec ?suivi=off
 * (?suivi=on pour annuler).
 */
(() => {
  const FUSEAU = 'Europe/Paris';

  const script = document.currentScript;
  const site = script && script.dataset.site;
  if (!site || !/^[a-z0-9-]{2,30}$/.test(site)) return;
  const BASE = (script.dataset.base || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+\.(firebasedatabase\.app|firebaseio\.com)$/.test(BASE)) return;
  const racine = new URL('.', script.src).pathname;
  const CLE = `suivi:${site}`;
  const IGNORER = 'suivi:ignorer';

  function stockage() {
    try {
      const q = new URLSearchParams(location.search).get('suivi');
      if (q === 'off') localStorage.setItem(IGNORER, '1');
      if (q === 'on') localStorage.removeItem(IGNORER);
      if (localStorage.getItem(IGNORER) === '1') return null;
      return JSON.parse(localStorage.getItem(CLE) || '{}') || {};
    } catch (e) {
      return null; // stockage bloqué : on ne compte pas, plutôt que de compter chaque page comme un nouveau visiteur
    }
  }

  function jourDe(date) {
    const p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: FUSEAU, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
    return `${p.year}-${p.month}-${p.day}`;
  }

  const nettoyer = (nom) => {
    const p = String(nom || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\.html?$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return p.length >= 2 && p !== 'index' ? p : '';
  };

  function pageActuelle() {
    if (script.dataset.page) return nettoyer(script.dataset.page) || 'accueil';
    const chemin = location.pathname.startsWith(racine) ? location.pathname.slice(racine.length) : '';
    let premier = '';
    try { premier = decodeURIComponent(chemin.split('/')[0] || ''); } catch (e) { /* adresse mal formée */ }
    return nettoyer(premier) || 'accueil';
  }

  const horsJeu = () => location.protocol === 'file:' || ['localhost', '127.0.0.1', ''].includes(location.hostname) || !navigator.onLine;
  const envoyer = (maj) => fetch(`${BASE}/.json`, { method: 'PATCH', body: JSON.stringify(maj), keepalive: true }).catch(() => {});
  const UN = { '.sv': { increment: 1 } };
  let pageCourante = pageActuelle();

  function compter(page) {
    pageCourante = page;
    if (horsJeu()) return;
    const memoire = stockage();
    if (!memoire) return;

    const jour = jourDe(new Date());
    const mois = jour.slice(0, 7);
    const s = `stats/${site}`;
    const d = `${s}/jours/${jour}`;
    const un = UN;
    const maj = { [`${d}/vues`]: un, [`${s}/total/vues`]: un };

    if (!memoire.vu) {
      maj[`${d}/nouveaux`] = un;
      maj[`${s}/total/visiteurs`] = un;
    }
    let pages = Array.isArray(memoire.pages) ? memoire.pages : [];
    if (memoire.jour !== jour) {
      const mobile = matchMedia('(pointer: coarse)').matches;
      const appli = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
      maj[`${d}/visiteurs`] = un;
      maj[`${d}/appareils/${mobile ? 'mobile' : 'ordi'}`] = un;
      if (appli) maj[`${d}/appli`] = un;
      pages = [];
    }
    if (memoire.mois !== mois) maj[`${s}/mois/${mois}/visiteurs`] = un;
    if (!pages.includes(page)) {
      maj[`${d}/pages/${page}`] = un;
      pages.push(page);
    }

    // Noté avant l'envoi : si l'envoi échoue, on perd une visite plutôt que d'en compter deux
    try {
      localStorage.setItem(CLE, JSON.stringify({ vu: true, jour, mois, pages }));
    } catch (e) { return; }

    envoyer(maj);
  }

  function action(nom, page) {
    const a = nettoyer(nom);
    const p = nettoyer(page) || pageCourante;
    if (!a || horsJeu() || !stockage()) return;
    const s = `stats/${site}`;
    envoyer({ [`${s}/jours/${jourDe(new Date())}/actions/${a}/${p}`]: UN, [`${s}/total/actions/${a}/${p}`]: UN });
  }

  // Première page : comptée un peu après l'ouverture, pour ne pas ralentir le site
  let pageInitiale = pageCourante;
  let lance = false;
  const lancer = () => setTimeout(() => { lance = true; compter(pageInitiale); }, 1500);
  if (document.readyState === 'complete') lancer();
  else addEventListener('load', lancer, { once: true });

  // Onglets d'un site d'une seule page : window.suivi.page('nom-de-l-onglet')
  window.suivi = {
    page(nom) {
      const page = nettoyer(nom);
      if (!page) return;
      if (!lance) { pageInitiale = page; pageCourante = page; return; } // pas encore compté : c'est cette page qui le sera
      compter(page);
    },
    action,
  };
})();
