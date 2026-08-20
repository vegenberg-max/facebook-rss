import express from "express";
import { chromium } from "playwright";
import fs from "fs/promises";

const app = express();

const PORT =
  process.env.PORT || 3000;

const SOURCES =
  JSON.parse(
    await fs.readFile(
      "./sources.json",
      "utf8"
    )
  );

let browser;


/* =========================================================
   HELPERS
========================================================= */

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanFacebookPostText(text) {

  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)

    /*
       Прибираємо типове сміття Facebook.
    */

    .filter(line =>
      !/^\d+\s*(ч\.|мин\.|минут|час|часы|h|hr|hrs|min)$/i.test(line)
    )

    .filter(line =>
      !/^·$/.test(line)
    )

    .filter(line =>
      !/^напишите\s+общедоступный\s+комментарий/i.test(line)
    )
    
    .filter(line =>
      !/^написать\s+общедоступный\s+комментарий/i.test(line)
    )
    
    .filter(line =>
      !/^написати\s+загальнодоступний\s+коментар/i.test(line)
    )

    .filter(line =>
      !/^write\s+a\s+public\s+comment/i.test(line)
    )

    .filter(line =>
      !/^комментировать$/i.test(line)
    )

    .filter(line =>
      !/^comment$/i.test(line)
    )

    /*
       Прибираємо сусідні дублікати рядків.
    */

    .filter((line, index, array) =>
      index === 0 ||
      line !== array[index - 1]
    )

    .join("\n")
    .trim();
}


function cleanFacebookPostUrl(url) {

  const value =
    String(url || "");

  const match =
    value.match(
      /https:\/\/www\.facebook\.com\/groups\/\d+\/posts\/\d+\//
    ) ||
    value.match(
      /https:\/\/www\.facebook\.com\/[^\/\s]+\/posts\/\d+\//
    ) ||
    value.match(
      /https:\/\/www\.facebook\.com\/reel\/\d+\//
    ) ||
    value.match(
      /https:\/\/www\.facebook\.com\/[^\/\s]+\/videos\/\d+\//
    );

  if (match) {
    return match[0];
  }

  return value.split("?")[0];
}

async function getBrowser() {

  if (browser) {
    return browser;
  }

  browser =
    await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    });

  return browser;
}


/* =========================================================
   FACEBOOK
========================================================= */

let facebookScrapeQueue =
  Promise.resolve();

/*
   Готові RSS зберігаємо в пам'яті.
   /feed/:id більше не чекатиме Facebook.
*/

const rssCache =
  new Map();

const rssUpdating =
  new Set();


async function updateFeedCache(
  source
) {

  if (
    rssUpdating.has(
      source.id
    )
  ) {
    return;
  }


  rssUpdating.add(
    source.id
  );


  try {

    console.log(
      "CACHE UPDATE START:",
      source.id
    );


    const posts =
      await scrapeFacebookQueued(
        source.url
      );


    /*
       Якщо Facebook тимчасово нічого
       не повернув, старий хороший кеш
       не стираємо.
    */

    if (
      posts.length === 0 &&
      rssCache.has(
        source.id
      )
    ) {

      console.log(
        "CACHE KEEP OLD:",
        source.id
      );

      return;
    }


    const rss =
      makeRss(
        source,
        posts
      );


    rssCache.set(
      source.id,
      {
        rss,
        posts:
          posts.length,
        updatedAt:
          Date.now()
      }
    );


    console.log(
      "CACHE UPDATE OK:",
      source.id,
      "POSTS:",
      posts.length
    );


  } catch (error) {

    console.log(
      "CACHE UPDATE ERROR:",
      source.id,
      String(error)
    );


  } finally {

    rssUpdating.delete(
      source.id
    );
  }
}

async function scrapeFacebookQueued(
  url
) {

  const previous =
    facebookScrapeQueue;


  let release;

  facebookScrapeQueue =
    new Promise(resolve => {
      release = resolve;
    });


  await previous;


  try {

    return await scrapeFacebook(
      url
    );

  } finally {

    release();
  }
}

async function scrapeFacebook(url) {

  const browser =
    await getBrowser();

  const context =
    await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
    });

  try {

    /*
       Facebook cookies із Render Environment.
    */

    try {

      const rawCookies =
        process.env.FACEBOOK_COOKIES;

      if (rawCookies) {

        const cookies =
          JSON.parse(
            rawCookies
          );

        if (
          Array.isArray(cookies) &&
          cookies.length > 0
        ) {

          const normalizedCookies =
            cookies.map(cookie => {

              const fixed = {
                ...cookie
              };

              const sameSite =
                String(
                  fixed.sameSite || ""
                ).toLowerCase();

              if (
                sameSite === "strict"
              ) {

                fixed.sameSite =
                  "Strict";

              } else if (
                sameSite === "lax"
              ) {

                fixed.sameSite =
                  "Lax";

              } else if (
                sameSite === "none" ||
                sameSite === "no_restriction"
              ) {

                fixed.sameSite =
                  "None";

              } else {

                delete fixed.sameSite;
              }


              /*
                 Поля Cookie-Editor,
                 які Playwright не потрібні.
              */

              delete fixed.id;
              delete fixed.storeId;
              delete fixed.hostOnly;
              delete fixed.session;

              return fixed;
            });


          await context.addCookies(
            normalizedCookies
          );


          console.log(
            "FACEBOOK COOKIES LOADED:",
            normalizedCookies.length
          );
        }
      }

    } catch (error) {

      console.log(
        "FACEBOOK COOKIES ERROR:",
        String(error)
      );
    }


    const page =
      await context.newPage();


    /*
       Відкриваємо Facebook.

       Якщо Facebook завис —
       не валимо весь RSS/Render.
    */

    try {

      await page.goto(
        url,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            25000
        }
      );

    } catch (error) {

      console.log(
        "FACEBOOK GOTO ERROR:",
        url,
        String(error)
      );


      /*
         Навіть після timeout сторінка
         іноді вже частково завантажена.

         Якщо Facebook взагалі не відкрився —
         просто повертаємо порожній результат.
      */

      const currentUrl =
        page.url();


      if (
        !currentUrl ||
        currentUrl === "about:blank"
      ) {

        return [];
      }
    }


    /*
       Даємо Facebook трохи часу
       дорендерити пости.
    */

    await page.waitForTimeout(
      3000
    );


    console.log(
      "FACEBOOK URL:",
      page.url()
    );


    console.log(
      "FACEBOOK TITLE:",
      await page.title()
    );


    const articleCount =
      await page.locator(
        '[role="article"]'
      ).count();


    console.log(
      "ARTICLES FOUND:",
      articleCount
    );


    /*
       Беремо видимі пости.
    */

    const posts =
      await page.locator(
        '[role="article"]'
      ).evaluateAll(
        nodes => {

          return nodes
            .slice(0, 10)
            .map(node => {

              const text =
                node.innerText || "";


              /*
                 Шукаємо Facebook post/reel URL.
              */

              const links =
                [...node.querySelectorAll("a")]
                  .map(a => a.href)
                  .filter(Boolean);


              const postUrl =
                links.find(
                  href =>
                    href.includes("/posts/") ||
                    href.includes("/reel/") ||
                    href.includes("/videos/")
                ) || "";


              /*
                 Фото.
              */

              const images =
                [
                  ...node.querySelectorAll(
                    "img"
                  )
                ]
                  .map(
                    img =>
                      img.src
                  )
                  .filter(
                    src =>
                      src &&
                      src.startsWith("http")
                  );


              return {

                text,

                postUrl,

                images:
                  [...new Set(images)]
              };

            })
            .filter(
              post =>
                post.text ||
                post.postUrl
            );
        }
      );


    const cleanedPosts =
      posts
        .map(post => {

          const cleanedText =
            cleanFacebookPostText(
              post.text
            );


          const cleanedUrl =
            cleanFacebookPostUrl(
              post.postUrl
            );


          return {

            ...post,

            text:
              cleanedText,

            postUrl:
              cleanedUrl
          };
        })
        .filter(
          post =>
            post.text ||
            post.postUrl
        );


    return cleanedPosts;


  } catch (error) {

    /*
       Будь-яка інша помилка одного feed
       не повинна валити весь Render.
    */

    console.log(
      "FACEBOOK SCRAPE ERROR:",
      url,
      String(error)
    );


    return [];


  } finally {

    /*
       ДУЖЕ ВАЖЛИВО.

       Context закривається ЗАВЖДИ:
       і після успіху,
       і після timeout,
       і після будь-якої помилки.
    */

    try {

      await context.close();

    } catch (error) {

      console.log(
        "FACEBOOK CONTEXT CLOSE ERROR:",
        String(error)
      );
    }
  }
}

/* =========================================================
   RSS
========================================================= */

function makeRss(
  source,
  posts
) {

  const items =
    posts.map(
      post => {

        const guid =
          post.postUrl ||
          post.text.slice(0, 100);


        const imageHtml =
          post.images
            .map(
              image =>
                `<img src="${escapeXml(image)}">`
            )
            .join("");


        return `
<item>
  <title>${escapeXml(
    post.text.slice(0, 120)
  )}</title>

  <link>${escapeXml(
    post.postUrl
  )}</link>

  <guid isPermaLink="false">${escapeXml(
    guid
  )}</guid>

  <description><![CDATA[
${post.text}

${imageHtml}
  ]]></description>

</item>
`;
      }
    )
    .join("\n");


  return `<?xml version="1.0" encoding="UTF-8"?>

<rss version="2.0">

<channel>

<title>Facebook RSS ${escapeXml(
    source.id
  )}</title>

<link>${escapeXml(
    source.url
  )}</link>

<description>
Custom Facebook RSS feed
</description>

${items}

</channel>

</rss>`;
}


/* =========================================================
   ROUTES
========================================================= */

app.get(
  "/",
  (
    req,
    res
  ) => {

    res.json({
      ok: true,
      service:
        "Facebook RSS",

      feeds:
        SOURCES.map(
          source =>
            `/feed/${source.id}`
        )
    });
  }
);

/* =========================================================
   FACEBOOK IMAGE PROXY
========================================================= */

app.get(
  "/image",
  async (
    req,
    res
  ) => {

    const imageUrl =
      String(
        req.query.url || ""
      );


    if (!imageUrl) {

      return res
        .status(400)
        .send(
          "Image URL required"
        );
    }


    /*
       Дозволяємо тільки Facebook CDN.
    */

    let parsed;

    try {

      parsed =
        new URL(
           imageUrl
        );

    } catch {

      return res
        .status(400)
        .send(
          "Invalid image URL"
        );
    }


    const hostname =
      parsed.hostname
        .toLowerCase();


    console.log(
      "IMAGE PROXY REQUEST:",
      imageUrl
    );
    
    console.log(
      "IMAGE PROXY HOST:",
      hostname
    );
    
    
    /*
       Дозволяємо Facebook CDN.
    */
    
    const allowedHost =
      hostname.endsWith(
        ".fbcdn.net"
      ) ||
      hostname ===
        "fbcdn.net" ||
      hostname.endsWith(
        ".facebook.com"
      );
    
    
    if (
      !allowedHost
    ) {
    
      console.log(
        "IMAGE PROXY BLOCKED HOST:",
        hostname
      );
    
      return res
        .status(403)
        .send(
          "Host not allowed: " +
          hostname
        );
    }
    
    let context;


    try {

      const browser =
        await getBrowser();


      context =
        await browser.newContext({
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
        });


      /*
         Додаємо Facebook cookies.
      */

      const rawCookies =
        process.env.FACEBOOK_COOKIES;


      if (rawCookies) {

        const cookies =
          JSON.parse(
            rawCookies
          );


        if (
          Array.isArray(cookies) &&
          cookies.length > 0
        ) {

          const normalizedCookies =
            cookies.map(cookie => {

              const fixed = {
                ...cookie
              };


              const sameSite =
                String(
                  fixed.sameSite || ""
                ).toLowerCase();


              if (
                sameSite === "strict"
              ) {

                fixed.sameSite =
                  "Strict";

              } else if (
                sameSite === "lax"
              ) {

                fixed.sameSite =
                  "Lax";

              } else if (
                sameSite === "none" ||
                sameSite ===
                  "no_restriction"
              ) {

                fixed.sameSite =
                  "None";

              } else {

                delete fixed.sameSite;
              }


              delete fixed.id;
              delete fixed.storeId;
              delete fixed.hostOnly;
              delete fixed.session;


              return fixed;
            });


          await context.addCookies(
            normalizedCookies
          );
        }
      }


      /*
         Render сам завантажує
         Facebook-картинку.
      */

      const response =
        await context.request.get(
          imageUrl,
          {
            headers: {
              Referer:
                "https://www.facebook.com/",

              Accept:
                "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
            },

            timeout:
              30000
          }
        );


      if (
        !response.ok()
      ) {

        console.log(
          "IMAGE PROXY ERROR:",
          response.status(),
          imageUrl
        );


        return res
          .status(
            response.status()
          )
          .send(
            "Facebook image error"
          );
      }


      const body =
        await response.body();


      const contentType =
        response.headers()[
          "content-type"
        ] ||
        "image/jpeg";


      res.set(
        "Content-Type",
        contentType
      );


      res.set(
        "Cache-Control",
        "public, max-age=3600"
      );


      return res.send(
        Buffer.from(
          body
        )
      );


    } catch (error) {

      console.log(
        "IMAGE PROXY EXCEPTION:",
        String(error)
      );


      return res
        .status(500)
        .send(
          "Image proxy failed"
        );


    } finally {

      if (context) {

        try {

          await context.close();

        } catch {
        }
      }
    }
  }
);

app.get(
  "/feed/:id",
  async (
    req,
    res
  ) => {

    console.log(
      "FEED REQUEST:",
      req.params.id,
      new Date().toISOString()
    );


    const source =
      SOURCES.find(
        item =>
          item.id ===
          req.params.id
      );


    if (!source) {

      return res
        .status(404)
        .send(
          "Feed not found"
        );
    }


    /*
       Якщо кеш уже є —
       RSS віддаємо МИТТЄВО.
    */

    const cached =
      rssCache.get(
        source.id
      );


    if (cached) {

      res.set(
        "Content-Type",
        "application/rss+xml; charset=utf-8"
      );


      res.set(
        "X-RSS-Cache",
        "HIT"
      );


      res.set(
        "X-RSS-Updated",
        new Date(
          cached.updatedAt
        ).toISOString()
      );


      /*
         Якщо кеш старший 10 хвилин,
         запускаємо оновлення у фоні.

         Користувач при цьому одразу
         отримує старий RSS.
      */

      if (
        Date.now() -
        cached.updatedAt >
        10 * 60 * 1000
      ) {

        updateFeedCache(
          source
        ).catch(
          error =>
            console.log(
              "BACKGROUND CACHE ERROR:",
              String(error)
            )
        );
      }


      return res.send(
        cached.rss
      );
    }


    /*
       Перший запит після рестарту Render.

       Щоб Cloudflare не чекав Chromium,
       віддаємо порожній валідний RSS
       і запускаємо заповнення кешу
       у фоні.
    */

    updateFeedCache(
      source
    ).catch(
      error =>
        console.log(
          "FIRST CACHE ERROR:",
          String(error)
        )
    );


    const emptyRss =
      makeRss(
        source,
        []
      );


    res.set(
      "Content-Type",
      "application/rss+xml; charset=utf-8"
    );


    res.set(
      "X-RSS-Cache",
      "MISS"
    );


    return res.send(
      emptyRss
    );
  }
);


app.listen(
  PORT,
  () => {

    console.log(
      `Facebook RSS running on port ${PORT}`
    );


    /*
       Після запуску Render
       поступово прогріваємо всі RSS.

       scrapeFacebookQueued сама
       поставить їх у чергу.
    */

    setTimeout(
      () => {

        console.log(
          "STARTING RSS CACHE WARMUP"
        );


        for (
          const source
          of SOURCES
        ) {

          updateFeedCache(
            source
          ).catch(
            error =>
              console.log(
                "WARMUP ERROR:",
                source.id,
                String(error)
              )
          );
        }

      },
      5000
    );
  }
);
