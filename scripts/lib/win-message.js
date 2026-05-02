/**
 * win-message.js
 *
 * Formats Whop-payment win announcements for Discord, scaling excitement
 * with the dollar amount. Used by the live watcher (discord-bot.js) and the
 * one-shot recovery script (announce-whop-payment.js).
 *
 * Each tier has its own rhyme pool — energy escalates with size.
 */

// ─── Rhyme pools — escalate from observational → unhinged ──────────────────────

// CHILL ($0–$499): observational wit — the originals you liked, plus a few
// cleverer idiom-flips and double meanings.
const CHILL_RHYMES = [
  // Originals
  "Yeast meets flour, hour by hour — bread on the rise, that's real power.",
  "Knead it, prove it, watch it climb — stacking loaves one at a time.",
  "Crust gold, crumb tight — Dilan baking through the night.",
  "Oven hot, dough's prepped — every notification one more step.",
  "Slice it thick, slice it thin — every transaction's a fresh win.",
  "Flour to dollar, dollar to crust — in this bakery we trust.",
  "Loaf by loaf the empire grows — that's just how the bread flows.",
  "Sourdough money, wild and free — fermenting in the treasury.",
  "Bake 'em, sell 'em, stack 'em high — bread don't sleep, neither do I.",
  "Toast that money, butter that flow — watch the warm green dough grow.",
  "Whisk it, mix it, watch it rise — bread money, no surprise.",
  "Crusty edge and fluffy heart — money making's a sacred art.",
  "Bread on bread on bread on bread — dough is multiplying instead.",
  "Sourdough starter never sleeps — neither does the bag he keeps.",
  "Bagel, baguette, sourdough boule — every cent's a baking tool.",
  "Carbs is currency 'round here — another loaf, another cheer.",
  "Flour, water, salt and yeast — bread god's blessing this big feast.",
  "Naan, focaccia, ciabatta — money's how we like to chatter.",
  "Gluten gains, monetary gains — same energy, different lanes.",
  "Cinnamon roll, hundred-dollar — call me Dilan dough-money baller.",
  "Bake and stack, bake and stack — bread's the only way back.",
  "Fresh from the oven, hot off the press — Whop just delivered, more or less.",
  "Pumpernickel paper, sourdough stacks — Dilan baking up the racks.",
  "Got the dough, got the bread, got the loaf — empire rising from the stove.",
  "Rolls in the oven, dough on the way — making more bread every single day.",
  "Pretzel knots and croissant flakes — every payment's another break.",
  "Brioche butter, ciabatta crunch — Pinnacle eating bread for lunch.",
  "Rye on rye on rye on rye — watch the bread reach for the sky.",
  "Bread machine beep, deposit ping — that's the sound of everything.",
  "Loaf goals stacked, dough goals fed — Pinnacle bakery in the green.",
  // Sharper additions: idiom flips, homophones, double meanings
  "Knead. Proof. Profit. Repeat — that's the recipe for the elite.",
  "The crust is the upper crust — bread money's a class adjustment.",
  "Rye bread, wry grin — Pinnacle's playing a long con to win.",
  "Half-baked plans, fully-baked pay — that's the Pinnacle way.",
  "Patience kneads its own reward — the bakery never gets bored.",
  "Sourdough takes time. Empires do too. Both ferment, both come through.",
  "Fold the dough, fold the bills — same wrist motion, different thrills.",
  "Bagels are circles, dollars run round — Pinnacle's geometry profoundly sound.",
  "A baker's dozen pays thirteen — Whop sent the bonus in between.",
  "The proof's in the pudding? Nah — the proof's in the dough you saw.",
  "Compound interest is the bread of patient men — Pinnacle's been baking it again and again.",
  "Crumbs to crowns, dough to throne — every bagel's a stepping stone.",
];

// GAS ($500–$1999): momentum + engine wit — bread as a machine in motion.
const GAS_RHYMES = [
  "Knead the dough, hit the gas — the bakery's RPMs are hard to surpass.",
  "Yeast in the engine, flour in the tank — Pinnacle's running, ask the bank.",
  "The oven preheats while the dollar pre-pays — that's GAS on dough-fueled days.",
  "Loaf-per-minute redline mode — Pinnacle's running the dough-lover's road.",
  "Crusts are crackling, dollars are stacking — Pinnacle's bakery steadily attacking.",
  "Convection convecting, deposits compounding — Pinnacle's bakery quietly astounding.",
  "Mile after mile, loaf after loaf — Pinnacle running on the bakery's stove.",
  "The dough-train's docking, the platform is hot — every payment's another shot.",
  "Sourdough at six thousand RPM — Pinnacle bakery here to win again.",
  "Fuel injector. Yeast injector. Same machine — Pinnacle's bakery a well-oiled scene.",
  "Pour the flour like premium octane — the bakery's running on a different lane.",
  "Idle is for engines that don't rise — Pinnacle's redlined under bread-money skies.",
];

// BIG PIF TIME ($2000–$2499): lump-sum, wholesale, uncut, no-payment-plan wit.
const BIG_PIF_RHYMES = [
  "PIF: three letters, four figures, one bag — Pinnacle's bakery just raised a flag.",
  "Uncut loaf, full bag, no slicing required — exactly the order the bakery desired.",
  "Wholesale dough, retail thrills — one PIF pays all the bills.",
  "When the deposit lands in a single thud — that's the sound of Pinnacle in flood.",
  "One transaction, one full sourdough boule — the bakery running on capital fuel.",
  "The PIF payer skips the payment plan — the baker just nods and bakes another pan.",
  "Lump-sum loaf from the wholesale shelf — Pinnacle's PIF is its own full self.",
  "Pay-in-full, no parts, no pieces, no plan — Pinnacle's PIF is the real bread man.",
  "Whole loaf, whole bag, whole bakery wins — that's exactly how PIF begins.",
  "Zero installments, infinite respect — Pinnacle's PIF: what we expect.",
  "No layaway, no maybe-someday, no slice — Pinnacle's PIF: the buyer paid twice the price.",
  "The check cleared before the bread did — Pinnacle's PIF, no payment plan needed.",
];

// INSANELY HYPE ($2500–$5999): chaos with a punchline — surreal, capslock, unhinged.
const INSANELY_HYPE_RHYMES = [
  "THE OVEN ACHIEVED CONSCIOUSNESS AT 2:47 AM — PINNACLE'S BAKERY IS A GRAND SLAM.",
  "GLUTEN UNIONS HAVE CONVENED. THE YEAST WANTS A RAISE. PINNACLE'S BAKERY IS UNGOVERNABLE THESE DAYS.",
  "THE BAGUETTES UNIONIZED. THE CIABATTAS WENT FREELANCE. PINNACLE'S BAKERY IS A HIGH-WIRE DANCE.",
  "THE HEALTH INSPECTOR LEFT IN TEARS OF JOY — PINNACLE'S BAKERY IS THE NEW EMPLOY.",
  "FOUR FIGURES OF FLOUR, FIVE FIGURES OF FAME — THE BAKERY HAS RENAMED THE GAME.",
  "THIS LOAF DOESN'T NEED A KNIFE — IT NEEDS A LAWYER. PINNACLE'S BAKERY IS BUYER, SELLER, PRAYER.",
  "THE FED CALLED. THEY WANT TO PEG THE DOLLAR TO A BAGUETTE. PINNACLE'S BAKERY HAS NO REGRET.",
  "THE CRUST CRACKED. THE OVEN APPLAUDED. PINNACLE'S BAKERY HAS BEEN AUDITED — AND APPLAUDED.",
  "THE BREAD SCREAMED 'I'M ALIVE' AND THEN INVOICED — PINNACLE'S BAKERY HAS REJOICED.",
  "BAGELS LEVITATING, INVOICES MULTIPLYING — PINNACLE'S BAKERY IS PHYSICS-DEFYING.",
  "SOMEONE PUT THE OVEN IN A HEADLOCK AND IT THANKED THEM — PINNACLE'S BAKERY HAS ASCENDED MAYHEM.",
  "THE FLOUR HAS A LAWYER. THE YEAST HAS A PUBLICIST. PINNACLE'S BAKERY IS AN UNHINGED ARTIST.",
];

// TOP ($6000+): world-historical, philosophical, museum-grade bread.
const TOP_RHYMES = [
  "ARCHAEOLOGISTS WILL DATE THIS LOAF AS ERA-DEFINING — PINNACLE'S BAKERY HAS BEGUN THE REFINING.",
  "BREAD HISTORIANS WILL DIVIDE TIME — BEFORE THIS LOAF, AFTER THIS LOAF. PINNACLE PRIME.",
  "WHEN THEY EXCAVATE THIS BAKERY IN THREE THOUSAND YEARS — THE LOAVES WILL STILL BE WARM, THE LEDGER STILL CLEAR.",
  "THE LOAF HAS ENTERED THE LOUVRE'S PERMANENT COLLECTION — PINNACLE'S BAKERY HAS REACHED PERFECTION.",
  "THE SUMERIANS HAD CUNEIFORM. THE EGYPTIANS HAD HIEROGLYPHS. PINNACLE HAS THIS LOAF — A NEW GLYPH.",
  "BREAD WAS A METAPHOR. THIS LOAF MADE IT LITERAL — PINNACLE'S BAKERY IS OFFICIALLY ETHEREAL.",
  "PHILOSOPHERS ASKED: WHAT IS THE PURPOSE OF BREAD? — PINNACLE BAKED THE ANSWER. NOTHING MORE TO BE SAID.",
  "THE INVENTOR OF BREAD JUST FILED A COPYRIGHT CLAIM — PINNACLE'S BAKERY HAS NO BLAME, ALL FAME.",
  "THE DOUGH HAS GAINED CITIZENSHIP IN THREE COUNTRIES — PINNACLE'S BAKERY KNOWS NO BOUNDARIES.",
  "BABYLON HAD GARDENS. ROME HAD AQUEDUCTS. PINNACLE HAS THIS LOAF — A NEW EMPIRE'S CONSTRUCT.",
  "THIS IS THE LOAF THAT ENDED THE GOLD STANDARD — PINNACLE'S BAKERY IS A MONETARY VANGUARD.",
  "FUTURE CIVILIZATIONS WILL CARBON-DATE THIS BREAD AND ASK 'HOW' — PINNACLE'S BAKERY ALREADY KNOWS THE TAO.",
];

const RHYMES_BY_TIER = {
  chill:          CHILL_RHYMES,
  gas:            GAS_RHYMES,
  big_pif:        BIG_PIF_RHYMES,
  insanely_hype:  INSANELY_HYPE_RHYMES,
  top:            TOP_RHYMES,
};

// ─── Emoji sets — bread + money pairs, escalating count by tier ────────────────

const WIN_EMOJI_SETS = [
  ['🍞', '💸'], ['💰', '🥖'], ['🤑', '🥯'], ['📈', '🍞'],
  ['💵', '🥐'], ['🔥', '🍞'], ['🥖', '💸'], ['🧈', '💰'],
];

function pickEmojiSet() {
  return WIN_EMOJI_SETS[Math.floor(Math.random() * WIN_EMOJI_SETS.length)];
}

// ─── Rhyme picker — avoids repeating the last rhyme within the same tier ──────

const lastRhymeIndexByTier = {};
function pickRhyme(tier) {
  const pool = RHYMES_BY_TIER[tier];
  if (!pool || pool.length === 0) return '';
  if (pool.length === 1) return pool[0];
  let i;
  do {
    i = Math.floor(Math.random() * pool.length);
  } while (i === lastRhymeIndexByTier[tier]);
  lastRhymeIndexByTier[tier] = i;
  return pool[i];
}

// ─── Tiers ────────────────────────────────────────────────────────────────────
// Highest threshold first so tierFor() finds the deepest match.
// Edit thresholds here to retune without touching the formatter.
const TIERS = [
  { min: 6000, name: 'top' },
  { min: 2500, name: 'insanely_hype' },
  { min: 2000, name: 'big_pif' },
  { min: 500,  name: 'gas' },
  { min: 0,    name: 'chill' },
];

function tierFor(amount) {
  return TIERS.find(t => amount >= t.min).name;
}

function formatAmount(amount) {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Build the Discord message for a Whop win, with formatting and rhyme pool
 * that scale by dollar amount.
 *
 * @param {number} amount  - USD amount (already final_amount or total)
 * @returns {string} message ready to send
 */
function formatWinMessage(amount) {
  const formatted = formatAmount(amount);
  const tier = tierFor(amount);
  const [a, b] = pickEmojiSet();
  const rhyme = pickRhyme(tier);

  switch (tier) {
    case 'chill':
      // Original vibe — keep as-is.
      return `${a}${b} **NEW WIN: $${formatted}** ${b}${a}\n_${rhyme}_`;

    case 'gas':
      // Doubled emojis, GAS framing, gas-pump accent
      return (
        `⛽${a}${b}${a}${b}⛽ **GAS: $${formatted}** ⛽${b}${a}${b}${a}⛽\n` +
        `_${rhyme}_`
      );

    case 'big_pif':
      // Big PIF — siren + cash accents around the bread emojis
      return (
        `🚨💵 **BIG PIF TIME: $${formatted}** 💵🚨\n` +
        `${a}${b}${a}${b}${a}${b}${a}${b}\n` +
        `_${rhyme}_`
      );

    case 'insanely_hype':
      // Multi-line, sirens, fire, capslock-ready rhyme
      return (
        `🚨🚨🚨 INSANELY HYPE 🚨🚨🚨\n` +
        `${a}${b}${a}${b}${a}${b}${a}${b}${a}${b}\n` +
        `# 🔥 $${formatted} 🔥\n` +
        `${b}${a}${b}${a}${b}${a}${b}${a}${b}${a}\n` +
        `_${rhyme}_`
      );

    case 'top':
      // Apex — the bakery has ascended
      return (
        `🌟🌟🌟 EVERYONE STOP 🌟🌟🌟\n` +
        `${a}${b}${a}${b}${a}${b}${a}${b}${a}${b}${a}${b}\n` +
        `# 💎🔥 TOP TIER WIN: $${formatted} 🔥💎\n` +
        `${b}${a}${b}${a}${b}${a}${b}${a}${b}${a}${b}${a}\n` +
        `## THE BAKERY HAS ASCENDED.\n` +
        `_${rhyme}_`
      );
  }
}

module.exports = { formatWinMessage, tierFor, TIERS };
