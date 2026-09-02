/* ================================================================
   SHARED.JS — Calculateur hydro-agricole (version multi-pages)
   Chargé par chaque page. Contient :
   - Constantes et formules (identiques à la version une-seule-page)
   - Composants UI communs (Field, NumberInput, Select, ResultCard, StackedAreaChart)
   - IdentityGate (authentification Netlify Identity)
   - Store (lecture/écriture localStorage — état "vivant" du projet en cours + projets nommés)
   - Nav / Footer partagés
   ================================================================ */

const { useState, useEffect, useMemo } = React;

/* ---------------- Constantes ---------------- */
const SOIL_DB = {
  "Sable":                              { fc: 0.09, wp: 0.02 },
  "Sable limoneux":                     { fc: 0.14, wp: 0.04 },
  "Limon sableux":                      { fc: 0.23, wp: 0.09 },
  "Limon sableux + matière organique":  { fc: 0.29, wp: 0.10 },
  "Limon":                              { fc: 0.34, wp: 0.12 },
  "Limon argileux":                     { fc: 0.30, wp: 0.16 },
  "Argille":                            { fc: 0.38, wp: 0.24 },
  "Argile bien structurée":             { fc: 0.50, wp: 0.30 },
};
const STD_DIAMETERS = [20,25,32,40,50,63,75,90,110,125,140,160,200,225,250,280,315];
const ROUGHNESS_OPTIONS = {
  "PVC / PEHD (lisse)": 0.0015,
  "Acier neuf": 0.045,
  "Acier galvanisé": 0.15,
  "Fonte": 0.26,
  "Béton lisse": 0.3,
  "Béton rugueux": 3,
};
const MASSE_VOL_EAU = 1000; // kg/m3, fixe
const VISCOSITE_EAU = 0.001; // Pa·s, eau à ≈20°C, fixe
const MONTHS = ["Jan","Fév","Mar","Avr","Mai","Juin","Juil","Août","Sep","Oct","Nov","Déc"];

/* ---------------- Fonctions de calcul ---------------- */
function frictionFactor(re, relRough) {
  if (!re || re <= 0) return null;
  if (re < 2300) return 64 / re; // régime laminaire
  const term = relRough / 3.7 + 5.74 / Math.pow(re, 0.9);
  return 0.25 / Math.pow(Math.log10(term), 2); // Swamee-Jain (≈Colebrook-White)
}

function priceEstimate(diamMm) {
  const anchors = [[16,120],[20,180],[25,280],[32,420],[40,600],[50,850],[63,1300],[75,1700],[90,2200],[110,8250],[125,9200],[140,10500],[160,12500],[200,16000],[250,21000],[315,29000]];
  if (diamMm <= anchors[0][0]) return anchors[0][1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [d1, p1] = anchors[i], [d2, p2] = anchors[i + 1];
    if (diamMm >= d1 && diamMm <= d2) { const t = (diamMm - d1) / (d2 - d1); return p1 + t * (p2 - p1); }
  }
  return anchors[anchors.length - 1][1];
}

function pluieEfficace(p) {
  if (p == null || p === "") return 0;
  if (p < 10) return p * 0.85;
  if (p < 30) return p * 0.7;
  return p * 0.5;
}

function fmtDuree(heuresDecimal) {
  if (!isFinite(heuresDecimal) || heuresDecimal < 0) return "—";
  const h = Math.floor(heuresDecimal);
  const min = Math.round((heuresDecimal - h) * 60);
  return `${h} h ${min} min`;
}

// Bilan sol-eau-culture : reconstruit le tableau mensuel à partir des entrées brutes
function computeBilanTable(bi, largeur, longueur) {
  const b = bi || {};
  const soilType = b.soilType || "Limon sableux + matière organique";
  const { fc, wp } = SOIL_DB[soilType] || SOIL_DB["Limon sableux + matière organique"];
  const densite = b.densite ?? 1.4;
  const efficacite = b.efficacite ?? 0.8;
  const profRacinaire = b.profRacinaire ?? 0.3;
  const coefSol = b.coefSol ?? 0.99;
  const mad = b.mad ?? 0.6;
  const stade = b.stade || "Reproduction";
  const kcVeg = b.kcVeg ?? 0.9, kcRepro = b.kcRepro ?? 1.15, kcMatu = b.kcMatu ?? 0.5;
  const kc = { "Végétatif": kcVeg, "Reproduction": kcRepro, "Maturation": kcMatu }[stade];
  const freq = b.freq ?? 1;
  const etoMonthly = b.etoMonthly && b.etoMonthly.length === 12 ? b.etoMonthly : Array(12).fill("");
  const superficie = largeur * longueur;
  const volumeEauSol = (fc - wp) * superficie * profRacinaire * densite;
  const volumeUtile = volumeEauSol * coefSol;
  const volumeEfficace = volumeUtile * mad;
  const table = MONTHS.map((m, i) => {
    const etoJ = parseFloat(etoMonthly[i]) || 0;
    const etoMois = etoJ * 30;
    const etcJ = etoJ * kc;
    const etcM3j = etcJ * 10 * (superficie / 10000);
    const doseNette = freq * etcM3j;
    const doseBrute = doseNette / efficacite;
    return { month: m, etoJ, etoMois, etcJ, etcM3j, doseNette, doseBrute };
  });
  return { table, superficie, fc, wp, kc, volumeEauSol, volumeUtile, volumeEfficace };
}

// Goutte-à-goutte : formules issues du fichier Excel
function computeDripData(di, largeur, longueur) {
  const d = di || {};
  const sens = d.sens || "Largeur";
  const modeIrrigation = d.modeIrrigation ?? 2;
  const effMotopompe = d.effMotopompe ?? 0.75;
  const qGoutteur = d.qGoutteur ?? 2.2;
  const distLigne = d.distLigne ?? 1;
  const distGoutteur = d.distGoutteur ?? 0.5;
  const conserverDebit = d.conserverDebit || "Oui";
  const nbRampe = sens === "Largeur" ? longueur / distLigne : largeur / distLigne;
  const nbGoutteurParRampe = sens === "Largeur" ? largeur / distGoutteur : longueur / distGoutteur;
  const qRampe = (nbGoutteurParRampe * qGoutteur) / 1000;
  const qParcelleBrut = nbRampe * qRampe;
  const qMotopompe = effMotopompe && modeIrrigation ? qParcelleBrut / (effMotopompe * modeIrrigation) : null;
  const longueurTotaleRampes = sens === "Largeur" ? nbRampe * largeur : nbRampe * longueur;
  const longueurUneRampe = sens === "Largeur" ? largeur : longueur;
  const qParcelleRetenu = conserverDebit === "Non" && modeIrrigation ? qParcelleBrut / modeIrrigation : qParcelleBrut;
  const qPrimaire = modeIrrigation ? qParcelleBrut / modeIrrigation : qParcelleBrut;
  return { nbRampe, nbGoutteurParRampe, qRampe, qParcelleBrut, qMotopompe, longueurTotaleRampes, longueurUneRampe, qParcelleRetenu, qPrimaire, modeIrrigation, conserverDebit, type: "goutte" };
}

// Aspersion : P_th, P, E_réel, A, R_marge, D_asperseur — densité au format "E_ligne x E_cible"
function computeAspersionData(ai, largeur, longueur) {
  const a = ai || {};
  const sens = a.sens || "Largeur";
  const modeIrrigation = a.modeIrrigation ?? 2;
  const effMotopompe = a.effMotopompe ?? 0.75;
  const debitUnitaire = a.debitUnitaire ?? 1.2;
  const densite = a.densite ?? "3 x 2.5";
  const xBord = a.xBord ?? 4;
  const margeM = a.margeM ?? 1;
  const conserverDebit = a.conserverDebit || "Oui";

  const parts = densite.split(/[xX*]/).map(s => parseFloat(s.trim()));
  const valid = parts.length === 2 && parts.every(n => !isNaN(n) && n > 0);
  if (!valid) {
    return { nbLignes: 0, nbArroseurParLigne: 0, nbArroseursTotal: 0, qRampe: 0, qParcelleBrut: 0, qMotopompe: null,
      longueurTotaleRampes: 0, longueurUneRampe: 0, qParcelleRetenu: 0, qPrimaire: 0, pluviometrie: 0, debitUnitaire,
      Pth_r: 0, P_r: 0, Ereel_r: 0, Rmarge_r: 0, Pth_l: 0, P_l: 0, Ereel_l: 0, Rmarge_l: 0, rayonJetRequis: 0, diamAsperseurRequis: 0,
      modeIrrigation, conserverDebit, type: "aspersion", densiteValid: false };
  }
  const espacementLigne = parts[0], espacementArroseur = parts[1];
  const L_rampe = sens === "Largeur" ? largeur : longueur;
  const L_lignes = sens === "Largeur" ? longueur : largeur;

  const Pth_r = (L_rampe - 2 * xBord) / espacementArroseur + 1;
  const P_r = Math.floor(Pth_r);
  const A_r = Math.max(0, P_r - 1);
  const Ereel_r = A_r > 0 ? (L_rampe - 2 * xBord) / A_r : 0;
  const Rmarge_r = xBord + Ereel_r / 2 + margeM;

  const Pth_l = (L_lignes - 2 * xBord) / espacementLigne + 1;
  const P_l = Math.floor(Pth_l);
  const A_l = Math.max(0, P_l - 1);
  const Ereel_l = A_l > 0 ? (L_lignes - 2 * xBord) / A_l : 0;
  const Rmarge_l = xBord + Ereel_l / 2 + margeM;

  const rayonJetRequis = Math.max(Rmarge_r, Rmarge_l);
  const diamAsperseurRequis = 2 * rayonJetRequis;
  const nbArroseurParLigne = A_r, nbLignes = A_l;
  const longueurUneRampe = Math.max(0, L_rampe - xBord);
  const qRampe = nbArroseurParLigne * debitUnitaire;
  const qParcelleBrut = nbLignes * qRampe;
  const qMotopompe = effMotopompe && modeIrrigation ? qParcelleBrut / (effMotopompe * modeIrrigation) : null;
  const longueurTotaleRampes = nbLignes * longueurUneRampe;
  const qParcelleRetenu = conserverDebit === "Non" && modeIrrigation ? qParcelleBrut / modeIrrigation : qParcelleBrut;
  const qPrimaire = modeIrrigation ? qParcelleBrut / modeIrrigation : qParcelleBrut;
  const nbArroseursTotal = nbLignes * nbArroseurParLigne;
  const pluviometrie = (debitUnitaire / ((Ereel_l * Ereel_r) || (espacementLigne * espacementArroseur))) * 1000;

  return { nbLignes, nbArroseurParLigne, nbArroseursTotal, qRampe, qParcelleBrut, qMotopompe, longueurTotaleRampes,
    longueurUneRampe, qParcelleRetenu, qPrimaire, pluviometrie, debitUnitaire,
    Pth_r, P_r, Ereel_r, Rmarge_r, Pth_l, P_l, Ereel_l, Rmarge_l, rayonJetRequis, diamAsperseurRequis,
    modeIrrigation, conserverDebit, type: "aspersion", densiteValid: true };
}

function getDesignData(live) {
  return live.irrigationType === "aspersion"
    ? computeAspersionData(live.aspersionInputs, live.largeur || 100, live.longueur || 100)
    : computeDripData(live.dripInputs, live.largeur || 100, live.longueur || 100);
}

/* ---------------- Store (localStorage) ---------------- */
const LIVE_KEY = "irripredict_live_v1";
const PROJECTS_KEY = "irripredict_projects_v1";

function loadLive() {
  try { const raw = localStorage.getItem(LIVE_KEY); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}
function saveLive(partial) {
  try {
    const current = loadLive();
    const next = { ...current, ...partial };
    localStorage.setItem(LIVE_KEY, JSON.stringify(next));
    return next;
  } catch (e) { return partial; }
}
function loadProjects() {
  try { const raw = localStorage.getItem(PROJECTS_KEY); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}
function saveProjects(projects) {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); } catch (e) {}
}

/* ---------------- Composants UI communs ---------------- */
function Field({ label, unit, children, hint }) {
  return (
    <label className="block mb-4">
      <span className="flex items-baseline justify-between text-sm font-medium text-[#17324d] mb-1.5">
        <span>{label}</span>
        {unit && <span className="text-xs text-[#60707d] font-mono">{unit}</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-[#60707d] mt-1">{hint}</span>}
    </label>
  );
}
function NumberInput({ value, onChange, step = "any" }) {
  return (
    <input type="number" value={value} step={step}
      onChange={(e) => onChange(e.target.value === "" ? "" : parseFloat(e.target.value))}
      className="w-full rounded-lg border border-[#dce5e1] bg-white px-3 py-2 font-mono text-[#17324d] focus:outline-none focus:ring-2 focus:ring-[#1d6f5b] focus:border-[#1d6f5b]" />
  );
}
function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-[#dce5e1] bg-white px-3 py-2 text-[#17324d] focus:outline-none focus:ring-2 focus:ring-[#1d6f5b] focus:border-[#1d6f5b]">
      {options.map((o) => (<option key={o} value={o}>{o}</option>))}
    </select>
  );
}
function ResultCard({ label, value, unit, big }) {
  return (
    <div className="rounded-xl border border-[#dce5e1] bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-[#60707d] font-semibold mb-1">{label}</div>
      <div className={`font-mono text-[#17324d] ${big ? "text-3xl" : "text-xl"} font-bold`}>
        {value}<span className="text-sm font-normal text-[#60707d] ml-1">{unit}</span>
      </div>
    </div>
  );
}

function StackedAreaChart({ monthly }) {
  if (!monthly || monthly.length === 0) return null;
  const W = 720, H = 220, padL = 36, padB = 22, padT = 10, padR = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = monthly.length;
  const maxVal = Math.max(...monthly.flatMap(m => [m.doseBruteM3, m.etoM3 + m.besoinNetM3]), 0.0001) * 1.1;
  const x = (i) => padL + (i / (n - 1)) * plotW;
  const y = (v) => padT + plotH - (v / maxVal) * plotH;
  const baseline = monthly.map((m, i) => [x(i), y(0)]);
  const etoLine = monthly.map((m, i) => [x(i), y(m.etoM3)]);
  const topLine = monthly.map((m, i) => [x(i), y(m.etoM3 + m.besoinNetM3)]);
  const toPath = (pts) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const areaEto = toPath(etoLine) + " " + toPath([...baseline].reverse()).replace("M", "L");
  const areaBesoin = toPath(topLine) + " " + toPath([...etoLine].reverse()).replace("M", "L");
  const barW = Math.min(26, (plotW / n) * 0.4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {[0, 0.25, 0.5, 0.75, 1].map((f, idx) => (
        <line key={idx} x1={padL} x2={W - padR} y1={padT + plotH * (1 - f)} y2={padT + plotH * (1 - f)} stroke="#eef2f0" />
      ))}
      <path d={areaEto} fill="#f6c893" fillOpacity="1" stroke="#d98f4e" strokeWidth="1.5" />
      <path d={areaBesoin} fill="#8fceb4" fillOpacity="1" stroke="#1d6f5b" strokeWidth="1.5" />
      {monthly.map((m, i) => {
        const barH = plotH - (y(m.doseBruteM3) - padT);
        return <rect key={i} x={x(i) - barW / 2} y={y(m.doseBruteM3)} width={barW} height={barH} fill="#3f6f96" fillOpacity="0.88" stroke="#17324d" strokeWidth="1.5" rx="2" />;
      })}
      {monthly.map((m, i) => (
        <text key={i} x={x(i)} y={H - 4} fontSize="9.5" textAnchor="middle" fill="#111827" fontFamily="monospace" fontWeight="700">{m.month}</text>
      ))}
    </svg>
  );
}

/* ---------------- Authentification (mot de passe simple) ----------------
   Choix délibéré après échec de Netlify Identity sur navigateurs mobiles
   (widget en iframe peu fiable, bug documenté sur Chrome/Samsung Internet).
   Ce n'est pas un système de comptes individuels, juste un mot de passe
   partagé qui fonctionne de façon fiable partout. sessionStorage est
   partagé entre toutes les pages de ce site (même origine), donc l'accès
   se déverrouille une fois pour toute la session de navigation. */
const SITE_PASSWORD = "hydro2026"; // <-- change cette valeur si besoin
const SESSION_KEY = "irripredict_unlocked";

function IdentityGate({ children }) {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(SESSION_KEY) === "1");
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  if (unlocked) return children;

  const submit = (e) => {
    e.preventDefault();
    if (input === SITE_PASSWORD) {
      sessionStorage.setItem(SESSION_KEY, "1");
      setUnlocked(true);
    } else {
      setError(true);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f2537] flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-2xl p-8 shadow-xl">
        <div className="text-xs font-bold uppercase tracking-widest text-[#1d6f5b] mb-1">Accès restreint</div>
        <h1 className="text-xl font-bold text-[#17324d] mb-5">Calculateur hydro-agricole</h1>
        <input
          type="password"
          autoFocus
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(false); }}
          placeholder="Mot de passe"
          className={`w-full rounded-lg border px-3 py-2.5 font-mono mb-2 focus:outline-none focus:ring-2 focus:ring-[#1d6f5b] ${error ? "border-red-400" : "border-[#dce5e1]"}`}
        />
        {error && <p className="text-xs text-red-500 mb-3">Mot de passe incorrect.</p>}
        <button type="submit" className="w-full bg-[#1d6f5b] text-white rounded-lg py-2.5 font-semibold mt-2 hover:bg-[#175a4a] transition-colors">
          Accéder
        </button>
      </form>
    </div>
  );
}

/* ---------------- Navigation & pied de page partagés ---------------- */
const NAV_LINKS = [
  { href: "index.html", label: "Accueil" },
  { href: "bilan-sol-eau.html", label: "Bilan sol-eau-culture" },
  { href: "conception.html", label: "Conception réseau" },
  { href: "reseau.html", label: "Dimensionnement réseau" },
  { href: "bilan-hydrique.html", label: "Bilan hydrique" },
  { href: "cout.html", label: "Coût & Rapport" },
];

function PageNav({ current }) {
  return (
    <nav className="bg-white border-b border-[#dce5e1] sticky top-0 z-10">
      <div className="max-w-5xl mx-auto px-6 flex gap-1 overflow-x-auto">
        {NAV_LINKS.map(l => (
          <a key={l.href} href={l.href}
            className={`flex items-center gap-2 px-4 py-3.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${current === l.href ? "border-[#1d6f5b] text-[#1d6f5b]" : "border-transparent text-[#60707d] hover:text-[#17324d]"}`}>
            {l.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

function PageHeader({ title, subtitle }) {
  const [live, setLive] = useState(() => loadLive());
  return (
    <header className="bg-[#17324d] text-white">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="text-xs font-bold uppercase tracking-widest text-[#9ed2c0]">Outil technique</div>
        <h1 className="text-2xl md:text-3xl font-bold mt-1">{title || "Calculateur hydro-agricole"}</h1>
        <p className="text-[#d6e0e6] text-sm mt-1">{subtitle || "Besoin en eau, dimensionnement de réseau et bilan hydrique — estimation de pré-dimensionnement"}</p>
        {live.cropName && <p className="text-[#9ed2c0] text-xs mt-2">Projet en cours : <b>{live.cropName}</b> · {live.irrigationType === "aspersion" ? "🌧 Aspersion" : "💧 Goutte-à-goutte"}</p>}
      </div>
    </header>
  );
}

function PageFooter() {
  return (
    <footer className="text-center text-xs text-[#60707d] py-8">
      TOURÉ OUOLO AIMÉ CÉSAR — Ingénierie hydroagricole · Outil de pré-dimensionnement, à valider par étude détaillée
      <div className="mt-2 text-base">
        <a href="mailto:ouolo.3.toure@gmail.com" className="text-[#1d6f5b] font-bold hover:underline">E-mail</a>
        <span className="mx-3 text-[#dce5e1]">·</span>
        <a href="https://wa.me/2250789426141" target="_blank" className="text-[#1d6f5b] font-bold hover:underline">WhatsApp</a>
      </div>
      <p className="text-[10px] text-[#8a97a1] mt-3 max-w-lg mx-auto">
        Les données sont sauvegardées automatiquement sur cet appareil/navigateur (localStorage), à chaque champ modifié — aucun envoi sur internet.
      </p>
    </footer>
  );
}
