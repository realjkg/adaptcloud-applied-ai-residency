export default {
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    coverage: { reporter: ["text", "json-summary"] },
    environment: "node"
  }
};
