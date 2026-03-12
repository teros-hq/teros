/**
 * Agent Personalities Data
 *
 * Pre-defined names and surnames for random agent generation.
 * Avatar is determined by first name: {name}-avatar.jpg
 *
 * To add a new name, generate an avatar with Replicate Flux 1.1
 * and save it to packages/backend/static/{name}-avatar.jpg
 *
 * Total: 100 names (60 female + 40 male)
 */

// ============================================================================
// NAMES (First names)
// ============================================================================

export const FEMALE_NAMES = [
  // Original (11)
  'Berta',
  'Cora',
  'Diana',
  'Iria',
  'Lambda',
  'Luna',
  'Maya',
  'Nova',
  'Nua',
  'Vera',
  'Vita',
  // Expansion (50 more = 60 total)
  'Ada',
  'Alma',
  'Aria',
  'Aurora',
  'Bianca',
  'Camila',
  'Carla',
  'Carmen',
  'Clara',
  'Dalia',
  'Elena',
  'Elsa',
  'Emma',
  'Eva',
  'Freya',
  'Gaia',
  'Gemma',
  'Greta',
  'Hana',
  'Helena',
  'Ingrid',
  'Iris',
  'Ivy',
  'Jade',
  'Julia',
  'Kira',
  'Lara',
  'Lena',
  'Lia',
  'Lucia',
  'Mia',
  'Mila',
  'Nadia',
  'Nora',
  'Olivia',
  'Paula',
  'Rosa',
  'Ruby',
  'Sara',
  'Sonia',
  'Silvia',
  'Sofia',
  'Stella',
  'Tara',
  'Thea',
  'Uma',
  'Valeria',
  'Violeta',
  'Yara',
  'Zoe',
];

export const MALE_NAMES = [
  // Original (4)
  'Atlas',
  'Chen',
  'Rai',
  'Tiago',
  // Expansion (35 more = 40 total)
  'Adam',
  'Adrian',
  'Aiden',
  'Alex',
  'Ander',
  'Anton',
  'Arlo',
  'Bruno',
  'Caleb',
  'Carlos',
  'Dante',
  'Dario',
  'Diego',
  'Emil',
  'Erik',
  'Ethan',
  'Felix',
  'Finn',
  'Hugo',
  'Ivan',
  'Jonas',
  'Julian',
  'Kai',
  'Leo',
  'Liam',
  'Lucas',
  'Marco',
  'Mateo',
  'Max',
  'Nico',
  'Noah',
  'Oliver',
  'Oscar',
  'Pablo',
  'Roman',
];

// All available names (for validation)
export const ALL_NAMES = [...FEMALE_NAMES, ...MALE_NAMES];

// Names that have avatars generated (update as avatars are created)
// Run: bun scripts/generate-avatars.ts --list to see current status
export const NAMES_WITH_AVATARS = [
  // Female (17)
  'Ada',
  'Alma',
  'Aria',
  'Aurora',
  'Berta',
  'Bianca',
  'Camila',
  'Cora',
  'Diana',
  'Iria',
  'Lambda',
  'Luna',
  'Maya',
  'Nova',
  'Nua',
  'Vera',
  'Vita',
  // Male (4)
  'Atlas',
  'Chen',
  'Rai',
  'Tiago',
];

// ============================================================================
// SURNAMES
// ============================================================================

export const SURNAMES = [
  'Evergreen',
  'Thornwood',
  'Westbrook',
  'Ashford',
  'Blackwood',
  'Sterling',
  'Hartley',
  'Whitmore',
  'Fairfax',
  'Cromwell',
  'Blackstone',
  'Ravencroft',
  'Silverton',
  'Goldwyn',
  'Ironwood',
  'Stormwind',
  'Nightingale',
  'Clearwater',
  'Brightwood',
  'Shadowmere',
  'Winterbourne',
  'Summerfield',
  'Oakridge',
  'Pinehurst',
  'Meadowbrook',
  'Riverdale',
  'Stonehaven',
  'Foxworth',
  'Hawthorne',
  'Kingsley',
  'Lancaster',
  'Montgomery',
  'Pemberton',
  'Sinclair',
  'Thornton',
  'Weston',
  'Crawford',
  'Fletcher',
  'Gardner',
  'Hunter',
  'Mercer',
  'Prescott',
  'Ramsey',
  'Sawyer',
  'Spencer',
  'Vaughn',
  'Warren',
  'York',
  'Aldridge',
  'Beaumont',
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get avatar filename for a given name
 */
export function getAvatarForName(name: string): string {
  return `${name.toLowerCase()}-avatar.jpg`;
}

/**
 * Check if a name has an avatar generated
 */
export function hasAvatar(name: string): boolean {
  return NAMES_WITH_AVATARS.some((n) => n.toLowerCase() === name.toLowerCase());
}

/**
 * Get a random item from an array
 */
function randomItem<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * Get a random item from an array, excluding certain values
 */
function randomItemExcluding<T>(array: T[], exclude: T[]): T {
  const excludeLower = exclude.map((e) => String(e).toLowerCase());
  const available = array.filter((item) => !excludeLower.includes(String(item).toLowerCase()));
  if (available.length === 0) {
    return randomItem(array); // Fallback if all excluded
  }
  return randomItem(available);
}

export type Gender = 'female' | 'male';

export interface RandomPersonality {
  firstName: string;
  lastName: string;
  fullName: string;
  avatar: string;
  gender: Gender;
}

/**
 * Generate a random personality with name and avatar
 *
 * @param excludeFirstNames - First names to exclude (e.g., existing agent names)
 * @param preferredGender - Optional gender preference, random if not specified
 * @param onlyWithAvatars - Only use names that have avatars (default: true)
 */
export function generateRandomPersonality(
  excludeFirstNames: string[] = [],
  preferredGender?: Gender,
  onlyWithAvatars: boolean = true,
): RandomPersonality {
  // Pick gender randomly if not specified (weighted towards female since we have more female avatars)
  const gender: Gender = preferredGender || (Math.random() > 0.3 ? 'female' : 'male');

  // Pick name based on gender
  let names = gender === 'female' ? FEMALE_NAMES : MALE_NAMES;

  // Filter to only names with avatars if requested
  if (onlyWithAvatars) {
    names = names.filter((name) => hasAvatar(name));
  }

  const firstName = randomItemExcluding(names, excludeFirstNames);
  const lastName = randomItem(SURNAMES);
  const avatar = getAvatarForName(firstName);

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    avatar,
    gender,
  };
}

/**
 * Generate multiple unique personalities
 *
 * @param count - Number of personalities to generate
 * @param excludeFirstNames - First names to exclude
 * @param onlyWithAvatars - Only use names that have avatars (default: true)
 */
export function generateMultiplePersonalities(
  count: number,
  excludeFirstNames: string[] = [],
  onlyWithAvatars: boolean = true,
): RandomPersonality[] {
  const personalities: RandomPersonality[] = [];
  const usedNames = [...excludeFirstNames];

  for (let i = 0; i < count; i++) {
    const personality = generateRandomPersonality(usedNames, undefined, onlyWithAvatars);
    personalities.push(personality);
    usedNames.push(personality.firstName);
  }

  return personalities;
}
