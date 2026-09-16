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
const COMMERCIAL_DIAMETER_OPTIONS = STD_DIAMETERS;
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
function resolveCommercialDiameter(flowM3H, targetVelocityMps = 1.2) {
  const flowM3S = (Number(flowM3H) || 0) / 3600;
  const areaM2 = flowM3S / Math.max(targetVelocityMps, 0.0001);
  const theoreticalMm = Math.sqrt((4 * areaM2) / Math.PI) * 1000;
  const suggestedMm = STD_DIAMETERS.find(d => d >= theoreticalMm) ?? null;
  const maxCommercialMm = STD_DIAMETERS[STD_DIAMETERS.length - 1];
  const insufficient = theoreticalMm > maxCommercialMm;
  return {
    theoretical_diameter_mm: Number(theoreticalMm.toFixed(2)),
    commercial_diameter_suggested_mm: suggestedMm,
    commercial_diameter_selected_mm: null,
    retained_diameter_mm: null,
    commercial_diameter_available: !insufficient,
    commercial_diameter_insufficient: insufficient,
    commercial_diameter_max_mm: maxCommercialMm,
    commercial_diameter_status: insufficient ? "insufficient" : "available",
  };
}

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
  const raisonnement = a.raisonnement || "ligne"; // "ligne" | "interligne"
  const modeIrrigation = a.modeIrrigation ?? 2;
  const effMotopompe = a.effMotopompe ?? 0.75;
  const debitUnitaire = a.debitUnitaire ?? 1.2;
  const densite = a.densite ?? "2 x 2.5"; // "A x B" : A = entre plantes sur la ligne, B = entre lignes de plantation
  const xBord = a.xBord === "" || a.xBord == null ? 4 : parseFloat(a.xBord);  // x : bord (bout de ligne) → 1ère/dernière plante
  const yBord = a.yBord === "" || a.yBord == null ? 4 : parseFloat(a.yBord);  // y : bord latéral → 1ère/dernière ligne
  const margeM = a.margeM === "" || a.margeM == null ? 1 : parseFloat(a.margeM);
  const conserverDebit = a.conserverDebit || "Oui";
  const diametreArrosageUtilisateur = toNumber(a.diametreArrosageUtilisateur, null) ?? toNumber(a.diametreArrosageUser, null) ?? toNumber(a.irrigation_diameter_user_m, null);

  const zeroed = { nbLignes: null, nbArroseurParLigne: null, nbArroseursTotal: null, qRampe: null, qParcelleBrut: null, qMotopompe: null,
    longueurTotaleRampes: null, longueurUneRampe: null, qParcelleRetenu: null, qPrimaire: null, pluviometrie: null, debitUnitaire,
    rayonJetRequis: null, diamAsperseurRequis: null, diamAsperseurUtilisateur: null, diamAsperseurUtilise: null, sourceDiametreArrosage: "calculated", diametreArrosageErreur: null,
    A: null, B: null, P: null, nLignesPlantation: null, espacementTheorique: null,
    A_impair: null, A_pair: null, E_asp: null, nTuyaux: null, positionPremierTuyau: null, ecartementTuyaux: null,
    nbTuyauxImpairs: null, nbTuyauxPairs: null, raisonnement,
    modeIrrigation, conserverDebit, type: "aspersion", status: "invalid", densiteValid: false };

  const parts = densite.split(/[xX*]/).map(s => parseFloat(s.trim()));
  const valid = parts.length === 2 && parts.every(n => !isNaN(n) && n > 0);
  if (!valid) return zeroed;

  const A = parts[0]; // espacement entre deux plantes sur la ligne
  const B = parts[1]; // espacement entre deux lignes de plantation
  const L = longueur; // longueur de la parcelle
  const Larg = largeur; // largeur de la parcelle

  if (L - 2*xBord <= 0 || Larg - 2*yBord <= 0) return zeroed;

  // 1. Rayon et diamètre de l'asperseur
  const rayonRequis = B + margeM;
  const diamAsperseurRequis = 2 * rayonRequis;
  const diamAsperseurUtilisateur = diametreArrosageUtilisateur;
  if (diamAsperseurUtilisateur != null && diamAsperseurUtilisateur < diamAsperseurRequis) {
    return {
      ...zeroed,
      rayonJetRequis: rayonRequis,
      diamAsperseurRequis,
      diamAsperseurUtilisateur,
      diamAsperseurUtilise: null,
      sourceDiametreArrosage: "invalid",
      diametreArrosageErreur: "Le diamètre d’arrosage choisi doit être supérieur ou égal au diamètre requis.",
      status: "invalid",
      densiteValid: true,
    };
  }
  const sourceDiametreArrosage = diamAsperseurUtilisateur != null ? "user" : "calculated";
  const diamAsperseurUtilise = diamAsperseurUtilisateur ?? diamAsperseurRequis;
  const R = diamAsperseurUtilise / 2;

  // 2. Structure de la plantation
  const P = Math.floor((L - 2*xBord) / A + 1); // nombre de plantes par ligne
  const nLignesPlantation = Math.floor((Larg - 2*yBord) / B + 1); // nombre total de lignes de plantation

  // 4. Asperseurs sur une ligne de tuyau (motif triangulaire)
  const espacementTheorique = R * 1.732;
  const A_impair = Math.max(1, Math.floor((L - 2*xBord) / espacementTheorique + 1));
  const E_asp = A_impair > 1 ? (L - 2*xBord) / (A_impair - 1) : (L - 2*xBord);
  const A_pair = Math.max(0, A_impair - 1);

  // 3. Structure du réseau (selon le raisonnement choisi)
  let nTuyaux, positionPremierTuyau, ecartementTuyaux;
  if (raisonnement === "ligne") {
    nTuyaux = Math.ceil(nLignesPlantation / 2);
    positionPremierTuyau = yBord;
    ecartementTuyaux = 2 * B;
  } else {
    nTuyaux = Math.max(0, Math.ceil((nLignesPlantation - 1) / 2));
    positionPremierTuyau = yBord + B / 2;
    ecartementTuyaux = 2 * B;
  }

  const nbTuyauxImpairs = Math.ceil(nTuyaux / 2);
  const nbTuyauxPairs = Math.floor(nTuyaux / 2);
  const nbArroseursTotal = nbTuyauxImpairs * A_impair + nbTuyauxPairs * A_pair;

  const qRampeImpair = A_impair * debitUnitaire;
  const qRampePair = A_pair * debitUnitaire;
  const qParcelleBrut = nbTuyauxImpairs * qRampeImpair + nbTuyauxPairs * qRampePair;
  const qRampe = qRampeImpair; // débit le plus défavorable (ligne impaire, la plus chargée), utilisé pour dimensionner la rampe

  const longueurUneRampe = Math.max(0, L - xBord); // longueur du tuyau jusqu'au dernier asperseur (approximation, identique impair/pair)
  const longueurTotaleRampes = nTuyaux * longueurUneRampe;

  const qMotopompe = effMotopompe && modeIrrigation ? qParcelleBrut / (effMotopompe * modeIrrigation) : null;
  const qParcelleRetenu = conserverDebit === "Non" && modeIrrigation ? qParcelleBrut / modeIrrigation : qParcelleBrut;
  const qPrimaire = modeIrrigation ? qParcelleBrut / modeIrrigation : qParcelleBrut;
  const pluviometrie = (debitUnitaire / (E_asp * ecartementTuyaux)) * 1000; // mm/h, indicatif (motif triangulaire, pas un vrai quadrillage)

  return {
    nbLignes: nTuyaux, nbArroseurParLigne: A_impair, nbArroseursTotal, qRampe, qParcelleBrut, qMotopompe,
    longueurTotaleRampes, longueurUneRampe, qParcelleRetenu, qPrimaire, pluviometrie, debitUnitaire,
    rayonJetRequis: rayonRequis, diamAsperseurRequis, diamAsperseurUtilisateur, diamAsperseurUtilise, sourceDiametreArrosage, diametreArrosageErreur: null,
    A, B, P, nLignesPlantation, espacementTheorique, A_impair, A_pair, E_asp, nTuyaux,
    positionPremierTuyau, ecartementTuyaux, nbTuyauxImpairs, nbTuyauxPairs, raisonnement,
    modeIrrigation, conserverDebit, type: "aspersion", status: "valid", densiteValid: true,
  };
}

function getDesignData(live) {
  return live.irrigationType === "aspersion"
    ? computeAspersionData(live.aspersionInputs, live.largeur || 100, live.longueur || 100)
    : computeDripData(live.dripInputs, live.largeur || 100, live.longueur || 100);
}

/* ---------------- Store (localStorage) ---------------- */
const LIVE_KEY = "irripredict_live_v1";
const PROJECTS_KEY = "irripredict_projects_v1";
const DESIGN_SCHEMA_VERSION = "1.0.0";

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "" || value === " ") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFraction(value) {
  const number = toNumber(value, null);
  if (number === null || number <= 0) return null;
  const fraction = number > 1 ? number / 100 : number;
  return fraction <= 1 ? fraction : null;
}

function ensureStableId(existing, prefix) {
  if (existing && typeof existing === "string" && existing.trim()) return existing.trim();
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${random}`;
}

function normalizeDesignStatus(status) {
  const valid = ["draft", "validated", "archived"];
  return valid.includes(status) ? status : "draft";
}

function buildBaseDesignReference(live) {
  const baseLive = live || {};
  const inputMeta = baseLive.inputMeta || {};
  const width = inputMeta.width_entered === true ? toNumber(baseLive.largeur, null) : null;
  const length = inputMeta.length_entered === true ? toNumber(baseLive.longueur, null) : null;
  const cropName = baseLive.cropName || baseLive.project_name || "Projet non nommé";
  const calculationIrrigationType = baseLive.irrigationType === "aspersion" ? "aspersion" : "goutte";
  const irrigationType = inputMeta.irrigation_type_entered === true ? calculationIrrigationType : null;
  const designId = ensureStableId(baseLive.design_id, "DES");
  const designDate = baseLive.design_reference?.metadata?.design_date || new Date().toISOString().slice(0, 10);
  const designStatus = normalizeDesignStatus(baseLive.design_status || baseLive.design_reference?.metadata?.design_status || "draft");
  const soilType = baseLive.bilanInputs?.soilType || null;
  const soilInfo = soilType ? SOIL_DB[soilType] : null;
  const areaHa = width != null && length != null ? (width * length) / 10000 : null;

  const designData = getDesignData(baseLive);
  const networkInputs = baseLive.networkInputs || {};
  const material = networkInputs.material_user_set === true ? (networkInputs.materiau || null) : null;
  const availablePressure = toNumber(networkInputs.pressionDisponible, null) ?? toNumber(baseLive.pressureDisponible, null);
  const requiredPressure =
    toNumber(networkInputs.pressionRequise, null) ??
    toNumber(baseLive.requiredPressure, null) ??
    toNumber(baseLive.aspersionInputs?.pressionService, null) ??
    toNumber(baseLive.costInputs?.pressionRequiseGoutteur, null);
  const sectorFlowM3H = toNumber(designData?.qPrimaire, null);
  const pumpFlowM3H = toNumber(designData?.qMotopompe, null);
  const networkFlowM3H = toNumber(
    networkInputs.pipeType === "Rampe"
      ? designData?.qRampe
      : designData?.qPrimaire,
    null
  );
  const velocity = toNumber(networkInputs.vitesse, null);
  const reynolds = toNumber(networkInputs.reynolds, null);
  const friction = toNumber(networkInputs.frictionFactor, null);
  const headLoss = toNumber(networkInputs.perteCharge, null);
  const theoreticalDiameter = toNumber(networkInputs.diametreTheorique, null) ?? toNumber(networkInputs.diamTheorique, null) ?? toNumber(networkInputs.diamCalc, null);
  const suggestedDiameter = toNumber(networkInputs.diametreCommercialSuggere, null) ?? toNumber(networkInputs.commercialDiameterSuggested, null);
  const selectedDiameter = toNumber(networkInputs.diametreCommercialChoisi, null) ?? toNumber(networkInputs.commercialDiameterSelected, null);
  const retainedDiameter = toNumber(networkInputs.diametreRetenu, null);
  const irrigationDiameterRequiredM = toNumber(designData?.diamAsperseurRequis, null) ?? toNumber(baseLive.aspersionInputs?.diametreArrosageRequis, null);
  const irrigationDiameterUserM = toNumber(designData?.diamAsperseurUtilisateur, null);
  const irrigationDiameterUsedM = toNumber(designData?.diamAsperseurUtilise, null);
  const irrigationDiameterSource = designData?.sourceDiametreArrosage || (irrigationDiameterRequiredM != null ? "calculated" : "unknown");
  const irrigationDiameterError = designData?.diametreArrosageErreur || null;

  const sectors = Array.isArray(baseLive.sectors) && baseLive.sectors.length ? baseLive.sectors : [];

  const sectionRecords = Array.isArray(baseLive.sections) && baseLive.sections.length
    ? baseLive.sections.map((section, index) => ({
        pipe_id: ensureStableId(section?.pipe_id || section?.section_id || `${baseLive.design_id || "P"}-${index + 1}`, "P"),
        type: section?.type || networkInputs.pipeType || "primaire",
        material: section?.material || material,
        length_m: toNumber(section?.length_m, null) ?? toNumber(section?.longueur, null) ?? null,
        flow_m3_h: toNumber(section?.flow_m3_h, null) ?? toNumber(section?.debit, null) ?? networkFlowM3H,
        theoretical_diameter_mm: toNumber(section?.theoretical_diameter_mm, null) ?? theoreticalDiameter,
        commercial_diameter_suggested_mm: toNumber(section?.commercial_diameter_suggested_mm, null) ?? suggestedDiameter,
        commercial_diameter_selected_mm: toNumber(section?.commercial_diameter_selected_mm, null) ?? selectedDiameter,
        retained_diameter_mm: toNumber(section?.retained_diameter_mm, null) ?? retainedDiameter,
        commercial_diameter_status: section?.commercial_diameter_status || networkInputs.commercialDiameterStatus || null,
        roughness_mm: toNumber(section?.roughness_mm, null) ?? toNumber(networkInputs.rugosite, null),
        velocity_m_s: toNumber(section?.velocity_m_s, null) ?? velocity,
        reynolds: toNumber(section?.reynolds, null) ?? reynolds,
        friction_factor: toNumber(section?.friction_factor, null) ?? friction,
        head_loss_m: toNumber(section?.head_loss_m, null) ?? headLoss,
      }))
    : [{
        pipe_id: ensureStableId(baseLive.pipe_id, "P"),
        type: "primaire",
        material,
        length_m: toNumber(networkInputs.longueur, null),
        flow_m3_h: networkFlowM3H,
        theoretical_diameter_mm: theoreticalDiameter,
        commercial_diameter_suggested_mm: suggestedDiameter,
        commercial_diameter_selected_mm: selectedDiameter,
        retained_diameter_mm: retainedDiameter,
        commercial_diameter_status: networkInputs.commercialDiameterStatus || null,
        roughness_mm: toNumber(networkInputs.rugosite, null),
        velocity_m_s: velocity,
        reynolds: reynolds,
        friction_factor: friction,
        head_loss_m: headLoss,
      }];

  const pipes = Array.isArray(baseLive.pipes) && baseLive.pipes.length ? baseLive.pipes : sectionRecords;

  const sprinklers = calculationIrrigationType === "aspersion" && designData && (designData.densiteValid || designData.diametreArrosageErreur) ? [{
    type: "asperseur",
    manufacturer: baseLive.aspersionInputs?.manufacturer || "",
    model: baseLive.aspersionInputs?.model || "",
    unit_flow_m3_h: toNumber(designData.debitUnitaire, null),
    service_pressure_bar: toNumber(baseLive.aspersionInputs?.pressionService, null),
    required_radius_m: toNumber(designData.rayonJetRequis, null),
    required_irrigation_diameter_m: irrigationDiameterRequiredM,
    irrigation_diameter_required_m: irrigationDiameterRequiredM,
    user_irrigation_diameter_m: irrigationDiameterUserM,
    irrigation_diameter_user_m: irrigationDiameterUserM,
    used_irrigation_diameter_m: irrigationDiameterUsedM,
    irrigation_diameter_used_m: irrigationDiameterUsedM,
    irrigation_diameter_source: irrigationDiameterSource,
    irrigation_diameter_error: irrigationDiameterError,
    status: designData.status || (irrigationDiameterError ? "invalid" : "valid"),
    required_diameter_m: irrigationDiameterRequiredM,
    user_diameter_m: irrigationDiameterUserM,
    used_diameter_m: irrigationDiameterUsedM,
    diameter_source: irrigationDiameterSource,
    spacing_m: toNumber(designData.espacementTheorique, null),
    quantity: toNumber(designData.nbArroseursTotal, null),
  }] : [];

  const agronomy = {
    soil_type: soilType,
    field_capacity_fraction: baseLive.bilanInputs?.soilType ? toNumber(soilInfo?.fc, null) : null,
    wilting_point_fraction: baseLive.bilanInputs?.soilType ? toNumber(soilInfo?.wp, null) : null,
    bulk_density_g_cm3: toNumber(baseLive.bilanInputs?.densite, null),
    // The current form stores profRacinaire directly in metres.
    root_depth_m: toNumber(baseLive.bilanInputs?.profRacinaire, null),
    mad_fraction: normalizeFraction(baseLive.bilanInputs?.mad),
    irrigation_efficiency_fraction: normalizeFraction(baseLive.bilanInputs?.efficacite),
    crop_name: cropName,
    kc: toNumber(baseLive.bilanInputs?.kcVeg, null),
  };

  const systemCapacity = {
    design_system_flow_m3_h: null,
    maximum_design_flow_m3_h: toNumber(baseLive.maximum_design_flow_m3_h, null),
    pump_design_flow_m3_h: toNumber(baseLive.pump_design_flow_m3_h, null) ?? pumpFlowM3H,
    pump_max_flow_m3_h: toNumber(baseLive.pump_max_flow_m3_h, null),
    minimum_operating_pressure_bar: toNumber(baseLive.minimum_operating_pressure_bar, null) ?? requiredPressure,
    design_available_volume_m3_day: toNumber(baseLive.design_available_volume_m3_day, null),
  };

  const operationalConstraints = {
    time_window_h_day: toNumber(baseLive.time_window_h_day, null),
    maximum_runtime_h_day: toNumber(baseLive.maximum_runtime_h_day, null),
    water_availability_m3_day: toNumber(baseLive.water_availability_m3_day, null),
    energy_availability: baseLive.energy_availability ?? null,
  };

  const designMetadata = {
    design_id: designId,
    design_version: baseLive.design_version || "1",
    design_date: designDate,
    design_status: designStatus,
    source_application: "IRRIPREDICT",
  };

  return {
    schema_version: DESIGN_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    source: {
      application: "IRRIPREDICT",
      application_version: baseLive.application_version || DESIGN_SCHEMA_VERSION,
      design_id: designId,
    },
    project: {
      project_id: ensureStableId(baseLive.project_id, "PRJ"),
      project_name: cropName,
    },
    plot: {
      plot_id: ensureStableId(baseLive.plot_id, "PLOT"),
      plot_name: baseLive.plot_name || cropName,
      area_ha: areaHa,
      width_m: width,
      length_m: length,
    },
    crop: {
      crop_id: ensureStableId(baseLive.crop_id, "CROP"),
      name: cropName,
      cycle: baseLive.cycle || "",
    },
    design_reference: {
      metadata: designMetadata,
      flows: {
        ramp_flow_m3_h: toNumber(designData?.qRampe, null),
        field_gross_flow_m3_h: toNumber(designData?.qParcelleBrut, null),
        field_retained_flow_m3_h: toNumber(designData?.qParcelleRetenu, null),
        sector_flow_m3_h: sectorFlowM3H,
        pump_required_flow_m3_h: pumpFlowM3H,
        parallel_sectors: sectors.length ? toNumber(designData?.modeIrrigation, null) : null,
      },
      agronomy,
      irrigation_system: {
        system_id: ensureStableId(baseLive.system_id, "SYS"),
        irrigation_type: irrigationType,
        parallel_sectors: sectors.length
          ? (toNumber(baseLive.parallel_sectors, baseLive?.dripInputs?.modeIrrigation ?? baseLive?.aspersionInputs?.modeIrrigation ?? 1) || 1)
          : null,
      },
      pump: {
        design_flow_m3_h: pumpFlowM3H,
        design_head_m: toNumber(baseLive.pump_head_m, null),
        power_kw: toNumber(baseLive.pump_power_kw, null),
        efficiency_fraction: toNumber(baseLive.pump_efficiency_fraction, null),
      },
      sectors,
      pipes,
      sprinklers,
      hydraulics: {
        design_flow_m3_h: networkFlowM3H,
        velocity_m_s: velocity,
        reynolds: reynolds,
        friction_factor: friction,
        head_loss_m: headLoss,
        required_pressure_bar: requiredPressure,
        available_pressure_bar: availablePressure,
      },
      geometry: {
        width_m: width,
        length_m: length,
        area_m2: width != null && length != null ? width * length : null,
        area_ha: areaHa,
      },
    },
    system_capacity: systemCapacity,
    operational_constraints: operationalConstraints,
    operational_data: Array.isArray(baseLive.operational_data) ? baseLive.operational_data : [],
    derived_data: Array.isArray(baseLive.derived_data) ? baseLive.derived_data : [],
  };
}

function migrateLiveData(raw) {
  if (!raw || typeof raw !== "object") return {};
  const migrated = { ...raw };

  migrated.project_id = ensureStableId(migrated.project_id, "PRJ");
  migrated.plot_id = ensureStableId(migrated.plot_id, "PLOT");
  migrated.crop_id = ensureStableId(migrated.crop_id, "CROP");
  migrated.system_id = ensureStableId(migrated.system_id, "SYS");
  migrated.design_id = ensureStableId(migrated.design_id, "DES");
  migrated.design_version = migrated.design_version && migrated.design_version !== DESIGN_SCHEMA_VERSION
    ? migrated.design_version
    : "1";
  migrated.design_status = normalizeDesignStatus(migrated.design_status || "draft");
  migrated.irrigationType = migrated.irrigationType === "aspersion" ? "aspersion" : (migrated.irrigationType || "goutte");

  if (migrated.networkInputs) {
    const hasExplicitCommercialSelection =
      migrated.networkInputs.commercialDiameterSelected != null ||
      migrated.networkInputs.diametreCommercialChoisi != null;
    if (!hasExplicitCommercialSelection) {
      migrated.networkInputs.commercialDiameterSelected = null;
      migrated.networkInputs.diametreCommercialChoisi = null;
      migrated.networkInputs.diametreRetenu = null;
    }
  }

  migrated.source = migrated.source || {
    application: "IRRIPREDICT",
    application_version: migrated.application_version || DESIGN_SCHEMA_VERSION,
    design_id: migrated.design_id,
  };

  if (!migrated.design_reference || !migrated.design_reference.metadata) {
    const profile = buildBaseDesignReference(migrated);
    migrated.design_reference = profile.design_reference;
    migrated.schema_version = profile.schema_version;
    migrated.exported_at = profile.exported_at;
    migrated.source = profile.source;
    migrated.project = profile.project;
    migrated.plot = profile.plot;
    migrated.crop = profile.crop;
    migrated.system_capacity = profile.system_capacity;
    migrated.operational_constraints = profile.operational_constraints;
    migrated.operational_data = profile.operational_data;
    migrated.derived_data = profile.derived_data;
  }

  migrated.design_reference.metadata = migrated.design_reference.metadata || {};
  migrated.design_reference.metadata.design_id = migrated.design_reference.metadata.design_id || migrated.design_id;
  migrated.design_reference.metadata.design_version = migrated.design_reference.metadata.design_version || migrated.design_version || DESIGN_SCHEMA_VERSION;
  migrated.design_reference.metadata.design_date = migrated.design_reference.metadata.design_date || new Date().toISOString().slice(0, 10);
  migrated.design_reference.metadata.design_status = normalizeDesignStatus(migrated.design_reference.metadata.design_status || migrated.design_status || "draft");
  migrated.design_reference.metadata.source_application = "IRRIPREDICT";

  if (!migrated.project) {
    migrated.project = { project_id: migrated.project_id, project_name: migrated.cropName || "Projet non nommé" };
  }
  if (!migrated.plot) {
    migrated.plot = { plot_id: migrated.plot_id, plot_name: migrated.cropName || "Projet non nommé", area_ha: ((toNumber(migrated.largeur, 100) * toNumber(migrated.longueur, 100)) / 10000), width_m: toNumber(migrated.largeur, 100), length_m: toNumber(migrated.longueur, 100) };
  }
  if (!migrated.crop) {
    migrated.crop = { crop_id: migrated.crop_id, name: migrated.cropName || "", cycle: migrated.cycle || "" };
  }

  return migrated;
}

function normalizeLiveState(raw) {
  const current = migrateLiveData(raw || {});
  const next = { largeur: 100, longueur: 100, cropName: "", irrigationType: "goutte", ...current };
  next.project_id = ensureStableId(next.project_id, "PRJ");
  next.plot_id = ensureStableId(next.plot_id, "PLOT");
  next.crop_id = ensureStableId(next.crop_id, "CROP");
  next.system_id = ensureStableId(next.system_id, "SYS");
  next.design_id = ensureStableId(next.design_id, "DES");
  next.design_version = next.design_version || "1";
  next.design_status = normalizeDesignStatus(next.design_status || "draft");
  next.irrigationType = next.irrigationType === "aspersion" ? "aspersion" : "goutte";
  const profile = buildBaseDesignReference(next);
  next.design_reference = profile.design_reference;
  next.design_reference.metadata.design_id = next.design_id;
  next.design_reference.metadata.design_version = next.design_version;
  next.design_reference.metadata.design_status = next.design_status;
  next.schema_version = profile.schema_version;
  next.exported_at = profile.exported_at;
  next.source = profile.source;
  next.project = profile.project;
  next.plot = profile.plot;
  next.crop = profile.crop;
  next.system_capacity = profile.system_capacity;
  next.operational_constraints = profile.operational_constraints;
  next.operational_data = profile.operational_data;
  next.derived_data = profile.derived_data;
  return next;
}

function loadLive() {
  try {
    const raw = localStorage.getItem(LIVE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const migrated = normalizeLiveState(parsed);
    localStorage.setItem(LIVE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch (e) {
    return {};
  }
}
function saveLive(partial) {
  try {
    const current = normalizeLiveState(loadLive());
    const next = normalizeLiveState({ ...current, ...partial });
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

function exportDesignProfile(liveOverride) {
  try {
    const live = normalizeLiveState(liveOverride || loadLive());
    const profile = buildBaseDesignReference(live);
    const fileName = `irripredict-design-${live.design_id || profile.design_reference.metadata.design_id || "design"}-v${DESIGN_SCHEMA_VERSION}.json`;
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { fileName, profile };
  } catch (e) {
    console.error("exportDesignProfile", e);
    return null;
  }
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
  const activeRef = React.useRef(null);
  useEffect(() => {
    if (activeRef.current && typeof activeRef.current.scrollIntoView === "function") {
      activeRef.current.scrollIntoView({ behavior: "instant", inline: "center", block: "nearest" });
    }
  }, []);
  return (
    <nav className="bg-white border-b border-[#dce5e1] sticky top-0 z-10">
      <div className="max-w-5xl mx-auto px-6 flex gap-1 overflow-x-auto">
        {NAV_LINKS.map(l => (
          <a key={l.href} href={l.href} ref={current === l.href ? activeRef : null}
            className={`flex items-center gap-2 px-4 py-3.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${current === l.href ? "border-[#1d6f5b] text-[#1d6f5b] bg-[#eaf3ef]" : "border-transparent text-[#60707d] hover:text-[#17324d]"}`}>
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
