export const siteConfig = {
  name: "TraitSwap & LootBox",
  description: "Open-source NFT trait swapper and loot box system for Algorand",

  // Social links shown in header / footer (set to "" to hide)
  socials: {
    xUrl: "",          // e.g. "https://x.com/your_project"
    discordUrl: "",    // e.g. "https://discord.gg/your_invite"
  },

  // External links used across the site (set to "" to hide)
  externalLinks: {
    tokenClaimUrl: "",           // e.g. staking / claim portal
    secondaryMarketUrl: "",      // e.g. marketplace listing
  },

  // Optional game links displayed on a /games page
  // Remove this array or leave it empty if your project has no games.
  games: [
    // {
    //   id: "example-game",
    //   title: "My Game",
    //   description: "Short description of the game.",
    //   url: "https://example.com/my-game",
    // },
  ] as Array<{ id: string; title: string; description: string; url: string }>,
};

export const SITE_NAME = siteConfig.name;
export const SITE_DESCRIPTION = siteConfig.description;
