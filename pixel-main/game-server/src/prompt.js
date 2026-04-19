// prompt.js — translates player choices into a text description for the AI prompt

function buildCharacterDescription(choices) {
  const { hairStyle, hairColor, skinTone, outfit, outfitColor, accessory } = choices;

  let desc = `A young person with ${hairStyle.toLowerCase()} ${hairColor.toLowerCase()} hair, ` +
             `${skinTone.toLowerCase()} skin, ` +
             `wearing a ${outfitColor.toLowerCase()} ${outfit.toLowerCase()}`;

  if (accessory && accessory.toLowerCase() !== 'none') {
    const accMap = {
      'glasses': 'round glasses',
      'hat': 'a small cap',
      'scarf': 'a cozy scarf',
      'backpack': 'a small backpack',
    };
    desc += ` and ${accMap[accessory.toLowerCase()] || accessory.toLowerCase()}`;
  }

  return desc;
}

module.exports = { buildCharacterDescription };
