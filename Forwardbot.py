import os
import asyncio
import discord
import aiohttp
from dotenv import load_dotenv
from datetime import datetime, timezone

# Load .env from the same directory as this script
script_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(script_dir, ".env")
load_dotenv(env_path)

TOKEN = os.getenv("DISCORD_TOKEN")
INGEST_TOKEN = (os.getenv("INGEST_TOKEN") or "").strip()
API_URL = "https://dacapperclub.onrender.com/picks"

http_session: aiohttp.ClientSession | None = None

RECENT_IDS = set()

# Set your source channel IDs here
SOURCE_CHANNEL_IDS = [
    1376084801974567033,
    1355683438455160892,
    1437566118511382548,
    1438456354531709009,
    1341495756019863572,
    1341495848973893725,
    1424866369635090472,
    1341495927994581074,
    1438379286779265154,
    1341495943815630908,
    1429291734550057032,
    1341496027374424114,
    1355684172844367872,
    1341498223336099840,
    1373974011049938954,
    1341499471812624465,
    1422712121145430137,
    1340466570303897613,
    1341493924187078810,
    1341495657546121256,
    1438456068471652364,
    1375638948331917432,
    1366617380947492905,
    1423891465305718814,
    1429292260750790769,
    1352867581694054520,
    1358600346162823225,
    1355683644164800714,
    1341495693164019752,
    1438379846693556255,
    1373750190061781002,
    1362542525482537131,
    1341495872684556340,
    1366617614863826975,
    1364334395355304026,
    1341495902707253351,
    1351112911715831829,
    1352867416576622663,
    1341495966695690394,
    1341495978317840384,
    1351109955574304849,
    1341496002569310218,
    1343588079348486244,
    1350407569960861696,
    1350408208522547200,
    1341498236770324590,
    1341498268969865246,
    1350408056147677264,
    1341495989466304624,
    1352382567298629764,
    1355684864396890132,
    1341500024713904302,
    1375270170330792108,
    1359371937775878264,
    1368323336257540148,
    1341497886638215178,
    1366528741592797224,
    1341498255258812540,
    1341499454376775831,
    1053085749865623562,
    1219395974355746846,
    1053085779422871613, 
    1053085807382110310,
    1053085694836346880,
]

client = discord.Client()

async def post_to_website(session: aiohttp.ClientSession, payload: dict):
    """Send message data to your website API."""
    if not API_URL:
        return

    headers = {"Content-Type": "application/json"}
    if INGEST_TOKEN:
        headers["x-ingest-token"] = INGEST_TOKEN

    try:
        async with session.post(
            API_URL,
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            print("✅ Posted to website", resp.status)

            if resp.status != 200:
                text = await resp.text()
                print("⚠️ Website response:", text)

    except Exception as e:
        print(f"❌ Website POST error: {e}")



@client.event
async def on_ready():
    global http_session
    if http_session is None or http_session.closed:
        http_session = aiohttp.ClientSession()

    print(f"✅ Logged in as {client.user} (ID: {client.user.id})")

    if API_URL:
        print(f"🌐 Website forwarding ON -> {API_URL}")
    else:
        print("🟡 Website forwarding OFF (API_URL missing)")

@client.event
async def on_message(message: discord.Message):
    # ignore our own messages
    if message.author.id == client.user.id:
        return

    # only watch selected channels
    if message.channel.id not in SOURCE_CHANNEL_IDS:
        return

    # ✅ de-dupe (prevents double posts)
    if message.id in RECENT_IDS:
        return
    RECENT_IDS.add(message.id)

    # keep memory from growing forever
    if len(RECENT_IDS) > 5000:
        RECENT_IDS.clear()



    # Build payload for website
    attachments = []
    for a in message.attachments:
        attachments.append({
            "filename": a.filename,
            "url": a.url,
            "contentType": a.content_type,
            "size": a.size,
        })

    embeds = []
    for e in message.embeds:
        try:
            embeds.append(e.to_dict())
        except Exception:
            pass

    payload = {
        "channelId": str(message.channel.id),
        "channelName": getattr(message.channel, "name", None),
        "authorId": str(message.author.id),
        "authorName": str(message.author),
        "content": message.content or "",
        "attachments": attachments,
        "embeds": embeds,
        "createdAt": message.created_at.replace(tzinfo=timezone.utc).isoformat(),
    }

    print(f"📨 Forwarding message from {message.channel.id} by {message.author}: {message.content}")

    session = http_session
    if session is None or session.closed:
        return

    # ✅ send to website
    await post_to_website(session, payload)

    
async def main():
    global http_session
    try:
        await client.start(TOKEN)
    except discord.errors.LoginFailure:
        print("❌ Login failed: Invalid token")
    except Exception as e:
        print(f"❗ Unexpected error: {e}")
    finally:
        # ✅ CLEAN SHUTDOWN
        if http_session and not http_session.closed:
            await http_session.close()
            print("🧹 HTTP session closed")

if __name__ == "__main__":
    asyncio.run(main())
