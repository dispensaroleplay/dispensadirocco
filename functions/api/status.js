export async function onRequestGet(context) {
  const value = await context.env.SITE_STATE?.get("restaurant_status");

  return Response.json(
    {
      status: value === "open" || value === "closed" ? value : "unknown",
      updatedAt: await context.env.SITE_STATE?.get("restaurant_status_updated_at")
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
