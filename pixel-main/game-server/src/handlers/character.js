const { generateAvatar } = require('../avatar');
const { buildCharacterDescription } = require('../prompt');
const { sendTo } = require('../broadcast');
const socialEngine = require('../modules/socialEngine');

async function handleCreateCharacter(conn, payload) {
  // Accept direct description text (simple mode) or structured fields (legacy)
  let description = payload.description;
  if (!description) {
    const { hairStyle, hairColor, skinTone, outfit, outfitColor, accessory } = payload;
    description = buildCharacterDescription({ hairStyle, hairColor, skinTone, outfit, outfitColor, accessory });
  }
  // Sanitize: cap at 200 chars, wrap with guardrails
  description = `A young person, ${description.slice(0, 200)}`;

  console.log(`[character] createCharacter started player=${conn.playerId} desc="${description.slice(0, 60)}..."`);
  sendTo(conn, { type: 'character_generating', payload: { step: 'generating', message: 'AI is generating your sprite sheet…' } });

  try {
    const avatarUrl = await generateAvatar(conn.playerId, description);
    console.log(`[character] avatar generated player=${conn.playerId} url=${avatarUrl}`);

    sendTo(conn, { type: 'character_generating', payload: { step: 'saving', message: 'Saving your character…' } });
    await socialEngine.createPlayer(conn.playerId, conn.displayName, avatarUrl);
    console.log(`[character] player saved player=${conn.playerId}`);

    sendTo(conn, { type: 'character_created', payload: { avatarUrl, playerId: conn.playerId } });
  } catch (err) {
    if (err.code === 'AVATAR_LIMIT_REACHED') {
      console.log(`[character] limit reached player=${conn.playerId} count=${err.genCount}`);
      sendTo(conn, { type: 'character_error', payload: {
        code: 'AVATAR_LIMIT_REACHED',
        message: 'AVATAR_LIMIT_REACHED',
        existingAvatarUrl: err.existingAvatarUrl,
      }});
      return;
    }
    console.error(`[character] FAILED player=${conn.playerId}:`, err.message);
    sendTo(conn, { type: 'character_error', payload: { message: err.message || 'Character generation failed. Please try again.' } });
  }
}

module.exports = { handleCreateCharacter };
