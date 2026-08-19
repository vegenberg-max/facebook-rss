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

async function scrapeFacebook(url) {

  const browser =
    await getBrowser();

  const context =
    await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
    });


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


  await page.goto(
    url,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        30000
    }
  );


  /*
     Даємо Facebook
     трохи часу дорендеритись.
  */

  await page.waitForTimeout(
    4000
  );
  
  console.log(
    "FACEBOOK URL:",
    page.url()
  );
  
  console.log(
    "FACEBOOK TITLE:",
    await page.title()
  );
  
  console.log(
    "ARTICLES FOUND:",
    await page.locator(
      '[role="article"]'
    ).count()
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
      .filter(post =>
        post.text ||
        post.postUrl
      );
  
  await context.close();

  return cleanedPosts;
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


    try {

      const posts =
        await scrapeFacebook(
          source.url
        );


      const rss =
        makeRss(
          source,
          posts
        );


      res.set(
        "Content-Type",
        "application/rss+xml; charset=utf-8"
      );


      res.send(
        rss
      );


    } catch (error) {

      console.error(
        error
      );


      res
        .status(500)
        .send(
          String(
            error?.message ||
            error
          )
        );
    }
  }
);


app.listen(
  PORT,
  () => {

    console.log(
      `Facebook RSS running on port ${PORT}`
    );
  }
);
