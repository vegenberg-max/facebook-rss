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

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "";

const TELEGRAM_ADMIN_USERNAME =
  process.env.TELEGRAM_ADMIN_USERNAME || "";

const TELEGRAM_ADMIN_ID =
  process.env.TELEGRAM_ADMIN_ID || "";


let facebookAuthBroken =
  false;


async function sendTelegramAlert(
  text,
  pin = false
) {

  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_ADMIN_ID
  ) {

    console.log(
      "TELEGRAM ALERT SKIPPED: env not configured"
    );

    return null;
  }


  try {

    const response =
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              chat_id:
                TELEGRAM_ADMIN_ID,

              text,

              disable_notification:
                false
            })
        }
      );


    const result =
      await response.json();


    if (
      !result.ok
    ) {

      console.log(
        "TELEGRAM ALERT SEND ERROR:",
        JSON.stringify(result)
      );

      return result;
    }


    /*
       Якщо це важливе повідомлення
       про Facebook cookies —
       пробуємо його закріпити.
    */

    if (
      pin &&
      result.result?.message_id
    ) {

      try {

        const pinResponse =
          await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/pinChatMessage`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  chat_id:
                    TELEGRAM_ADMIN_ID,

                  message_id:
                    result.result.message_id,

                  disable_notification:
                    false
                })
            }
          );


        const pinResult =
          await pinResponse.json();


        console.log(
          "TELEGRAM ALERT PIN:",
          JSON.stringify(pinResult)
        );


      } catch (error) {

        console.log(
          "TELEGRAM ALERT PIN ERROR:",
          String(error)
        );
      }
    }


    return result;


  } catch (error) {

    console.log(
      "TELEGRAM ALERT ERROR:",
      String(error)
    );

    return null;
  }
}


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
      /https:\/\/www\.facebook\.com\/[^\/\s]+\/posts\/[^\/?\s]+\//
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


  /*
     Старі/альтернативні Facebook permalink URL:

     /permalink.php?story_fbid=XXX&id=YYY

     Тут НЕ можна просто відкидати query string,
     бо саме story_fbid та id визначають пост.
  */

  if (
    value.includes("/permalink.php")
  ) {

    try {

      const parsed =
        new URL(value);


      const storyFbid =
        parsed.searchParams.get(
          "story_fbid"
        );


      const id =
        parsed.searchParams.get(
          "id"
        );


      if (
        storyFbid &&
        id
      ) {

        return (
          "https://www.facebook.com/permalink.php" +
          "?story_fbid=" +
          encodeURIComponent(storyFbid) +
          "&id=" +
          encodeURIComponent(id)
        );
      }


      if (storyFbid) {

        return (
          "https://www.facebook.com/permalink.php" +
          "?story_fbid=" +
          encodeURIComponent(storyFbid)
        );
      }

    } catch {
    }
  }


  /*
     Для інших Facebook URL
     прибираємо службові параметри.
  */

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

const rssCache = new Map();

// Зберігаємо самі Promise, щоб кілька запитів
// одного RSS чекали на одне оновлення.
const rssUpdating = new Map();


async function updateFeedCache(source) {
  const id = String(source.id);

  // Якщо цей RSS уже оновлюється,
  // повертаємо поточну задачу.
  if (rssUpdating.has(id)) {
    return rssUpdating.get(id);
  }

  const task = (async () => {
    console.log("CACHE UPDATE START:", id);

    try {
      const posts = await scrapeFacebookQueued(
        source.url
      );

      // Порожній результат не вважаємо
      // успішним оновленням.
      if (!Array.isArray(posts) || posts.length === 0) {
        console.log(
          "CACHE EMPTY:",
          id,
          "KEEPING OLD CACHE"
        );

        return rssCache.get(id) || null;
      }

      const rss = makeRss(source, posts);

      const entry = {
        rss,
        posts: posts.length,
        updatedAt: Date.now()
      };

      rssCache.set(id, entry);

      console.log(
        "CACHE UPDATE OK:",
        id,
        "POSTS:",
        posts.length
      );

      return entry;

    } catch (error) {
      console.error(
        "CACHE UPDATE ERROR:",
        id,
        error
      );

      return rssCache.get(id) || null;
    }
  })();

  rssUpdating.set(id, task);

  try {
    return await task;
  } finally {
    if (rssUpdating.get(id) === task) {
      rssUpdating.delete(id);
    }
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

async function checkFacebookAuth() {

  const browser =
    await getBrowser();


  const context =
    await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
    });


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
          cookies.map(
            cookie => {

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
            }
          );


        await context.addCookies(
          normalizedCookies
        );
      }
    }


    const page =
      await context.newPage();


    await page.goto(
      "https://www.facebook.com/me",
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          25000
      }
    );


    await page.waitForTimeout(
      1500
    );


    const currentUrl =
      page.url();


    const authWorks =
      !currentUrl.includes(
        "facebook.com/login"
      );


    console.log(
      "FACEBOOK PERIODIC AUTH:",
      authWorks
        ? "OK"
        : "BROKEN",
      currentUrl
    );


    if (
      !authWorks &&
      !facebookAuthBroken
    ) {

      facebookAuthBroken =
        true;


      await sendTelegramAlert(

        "🚨 " +
        (
          TELEGRAM_ADMIN_USERNAME
            ? `@${TELEGRAM_ADMIN_USERNAME} `
            : ""
        ) +
        "ПОТРІБНІ НОВІ FACEBOOK COOKIES!\n\n" +
      
        "⚠️ Facebook-сесія на Render протухла.\n\n" +
      
        "RSS, які потребують авторизації, " +
        "тимчасово не читаються.\n\n" +
      
        "Публічні Facebook-сторінки продовжують працювати.\n\n" +
      
        "👉 Онови FACEBOOK_COOKIES у Render.",
      
        true
      );
    }


    if (
      authWorks &&
      facebookAuthBroken
    ) {

      facebookAuthBroken =
        false;


      await sendTelegramAlert(
        "✅ Facebook-сесію на Render відновлено. RSS знову можуть читати джерела, які потребують авторизації."
      );
    }


    return authWorks;


  } catch (error) {

    console.log(
      "FACEBOOK PERIODIC AUTH ERROR:",
      String(error)
    );


    /*
       Timeout сам по собі ще не означає,
       що cookies протухли.
    */

    return null;


  } finally {

    try {

      await context.close();

    } catch {
    }
  }
}

async function getFacebookPostFullText(
  context,
  postUrl,
  currentText = ""
) {

  if (!postUrl) {
    return currentText;
  }

  const isVideo =
    postUrl.includes("/reel/") ||
    postUrl.includes("/videos/");

  /*
     Додатково відкриваємо сам пост тільки для
     Reel/video. Звичайні пости не навантажуємо.
  */

  if (!isVideo) {
    return currentText;
  }

  let page;

  try {

    page = await context.newPage();

    console.log(
      "FACEBOOK OPEN POST FOR FULL TEXT:",
      postUrl
    );

    try {

      await page.goto(
        postUrl,
        {
          waitUntil: "domcontentloaded",
          timeout: 20000
        }
      );

    } catch (error) {

      console.log(
        "FACEBOOK FULL TEXT GOTO TIMEOUT:",
        postUrl,
        String(error)
      );
    }


    await page.waitForTimeout(2500);


    const fullText =
      await page.evaluate(() => {

        const candidates = [];


        /*
           1. Опис самого Facebook Reel/post.
        */

        const articles =
          [
            ...document.querySelectorAll(
              '[role="article"]'
            )
          ];

        for (const article of articles) {

          const text =
            (
              article.innerText ||
              ""
            ).trim();

          if (text) {
            candidates.push(text);
          }
        }


        /*
           2. Facebook іноді тримає caption
           поза role=article.
        */

        const textNodes =
          [
            ...document.querySelectorAll(
              '[data-ad-preview="message"], ' +
              '[data-ad-comet-preview="message"], ' +
              '[data-testid="post_message"]'
            )
          ];

        for (const node of textNodes) {

          const text =
            (
              node.innerText ||
              node.textContent ||
              ""
            ).trim();

          if (text) {
            candidates.push(text);
          }
        }


        /*
           Беремо найдовший змістовний варіант.
        */

        candidates.sort(
          (a, b) =>
            b.length - a.length
        );

        return candidates[0] || "";
      });


    console.log(
      "FACEBOOK FULL TEXT:",
      postUrl,
      fullText.slice(0, 500)
    );


    /*
       Не замінюємо старий текст гіршим/коротшим.
    */

    if (
      fullText &&
      fullText.length >
        String(currentText || "").length
    ) {

      return fullText;
    }


    return currentText;


  } catch (error) {

    console.log(
      "FACEBOOK FULL TEXT ERROR:",
      postUrl,
      String(error)
    );

    return currentText;


  } finally {

    if (page) {

      try {
        await page.close();
      } catch {
      }
    }
  }
}

async function getFacebookPostImages(
  context,
  postUrl,
  currentImages = []
) {
  if (!postUrl) {
    return currentImages;
  }

  let page;

  try {
    page = await context.newPage();

    console.log(
      "FACEBOOK OPEN POST FOR ORIGINAL IMAGES:",
      postUrl
    );

    try {
      await page.goto(
        postUrl,
        {
          waitUntil: "domcontentloaded",
          timeout: 20000
        }
      );
    } catch (error) {
      console.log(
        "FACEBOOK ORIGINAL IMAGES GOTO TIMEOUT:",
        postUrl,
        String(error)
      );
    }

    await page.waitForTimeout(2500);

    const originalImages =
      await page.evaluate(() => {

        const result = [];

        /*
         * 1. OG IMAGE — Facebook часто кладе сюди
         * найбільш якісне прев'ю самого поста.
         */
        const ogImages =
          [
            ...document.querySelectorAll(
              'meta[property="og:image"], meta[name="og:image"]'
            )
          ]
            .map(meta =>
              meta.getAttribute("content")
            )
            .filter(
              url =>
                url &&
                url.startsWith("http")
            );

        result.push(...ogImages);


        /*
         * 2. image_src
         */
        const imageSrc =
          document
            .querySelector(
              'link[rel="image_src"]'
            )
            ?.getAttribute("href");

        if (
          imageSrc &&
          imageSrc.startsWith("http")
        ) {
          result.push(imageSrc);
        }


        /*
         * 3. Великі Facebook CDN URL,
         * які вже є в HTML/JSON сторінки.
         */
        const html =
          document.documentElement.outerHTML;

        const fbUrls =
          html.match(
            /https?:\/\/[^"'\\\s<>]+(?:fbcdn\.net|facebook\.com)[^"'\\\s<>]*/gi
          ) || [];

        for (const url of fbUrls) {
          if (
            /\.(jpg|jpeg|png|webp)(?:[?&]|$)/i.test(
              url
            ) ||
            url.includes("scontent")
          ) {
            result.push(
              url
                .replace(/\\u0025/g, "%")
                .replace(/\\u0026/g, "&")
                .replace(/\\\//g, "/")
            );
          }
        }


        return [
          ...new Set(result)
        ];
      });


    console.log(
      "FACEBOOK ORIGINAL IMAGES FOUND:",
      originalImages.length
    );

    /*
     * Якщо сторінка поста дала картинки —
     * використовуємо їх.
     *
     * Якщо ні — залишаємо старі картинки.
     */
    if (
      originalImages.length > 0
    ) {
      return originalImages;
    }

    return currentImages;

  } catch (error) {

    console.log(
      "FACEBOOK ORIGINAL IMAGES ERROR:",
      postUrl,
      String(error)
    );

    return currentImages;

  } finally {

    if (page) {
      try {
        await page.close();
      } catch {}
    }
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

          console.log(
            "FACEBOOK COOKIE NAMES:",
            normalizedCookies.map(
              cookie => cookie.name
            )
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


/*
   FACEBOOK PAGE RECOVERY

   Facebook Groups на Render завантажуються
   нормально, тому їх не чіпаємо.

   Для звичайних Facebook Pages/Profile
   перевіряємо, чи реально з'явився контент.

   Якщо Facebook віддав тільки порожню
   оболонку — робимо одну повторну навігацію.
*/

const isFacebookGroup =
  url.includes(
    "facebook.com/groups/"
  );


if (!isFacebookGroup) {

  const hasPageContent =
    await page.evaluate(() => {
  
      const links =
        [
          ...document.querySelectorAll(
            'a[href]'
          )
        ]
          .map(a => a.href)
          .filter(Boolean);
  
  
      return links.some(href => {
  
        return (
          href.includes("/posts/") ||
          /\/reel\/\d+/.test(href) ||
          /\/videos\/\d+/.test(href) ||
          href.includes("/permalink.php") ||
          href.includes("story_fbid=")
        );
      });
    });


  if (!hasPageContent) {

    console.log(
      "FACEBOOK PAGE EMPTY, RETRY:",
      url
    );


    try {

      /*
         Для звичайних Facebook Pages/Profile
         пробуємо відкрити саме вкладку Posts.
      */
    
      const recoveryUrl =
        new URL(url);
    
      recoveryUrl.searchParams.set(
        "sk",
        "posts"
      );
    
    
      console.log(
        "FACEBOOK PAGE RECOVERY URL:",
        recoveryUrl.toString()
      );
    
    
      await page.goto(
        recoveryUrl.toString(),
        {
          waitUntil:
            "domcontentloaded",
    
          timeout:
            25000
        }
      );
    
    } catch (error) {

      console.log(
        "FACEBOOK PAGE RETRY GOTO ERROR:",
        url,
        String(error)
      );
    }


    /*
       Даємо React Facebook більше часу
       після повторної навігації.
    */

    await page.waitForTimeout(
      5000
    );


    /*
       Один scroll іноді запускає
       lazy-loading стрічки Page.
    */

    await page.evaluate(() => {

      window.scrollBy(
        0,
        Math.max(
          window.innerHeight,
          900
        )
      );

    });


    await page.waitForTimeout(
      3000
    );


    const recoveryDebug =
      await page.evaluate(() => {

        const main =
          document.querySelector(
            '[role="main"]'
          );


        const mainText =
          (
            main?.innerText ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();


        const postLinks =
          [
            ...document.querySelectorAll(
              'a[href]'
            )
          ]
            .map(a => a.href)
            .filter(
              href =>
                href &&
                (
                  href.includes("/posts/") ||
                  href.includes("/reel/") ||
                  href.includes("/videos/") ||
                  href.includes("/permalink.php") ||
                  href.includes("story_fbid=")
                )
            );


        return {
          mainLength:
            mainText.length,

          postLinks:
            [...new Set(postLinks)]
              .slice(0, 10)
        };
      });


    console.log(
      "FACEBOOK PAGE RECOVERY RESULT:",
      url,
      JSON.stringify(
        recoveryDebug
      )
    );
  }
}


const finalFacebookUrl =
  page.url();

    console.log(
      "FACEBOOK FINAL URL:",
      url,
      "=>",
      finalFacebookUrl
    );
    
    
    if (
      finalFacebookUrl.includes(
        "facebook.com/login"
      )
    ) {
    
      console.log(
        "FACEBOOK AUTH REQUIRED:",
        url
      );

      if (
        !facebookAuthBroken
      ) {
    
        facebookAuthBroken =
          true;
    
    
        await sendTelegramAlert(

          "🚨 " +
          (
            TELEGRAM_ADMIN_USERNAME
              ? `@${TELEGRAM_ADMIN_USERNAME} `
              : ""
          ) +
          "ПОТРІБНІ НОВІ FACEBOOK COOKIES!\n\n" +
        
          "⚠️ Facebook-сесія на Render протухла.\n\n" +
        
          "RSS, які потребують авторизації, " +
          "тимчасово не читаються.\n\n" +
        
          "Публічні Facebook-сторінки продовжують працювати.\n\n" +
        
          "👉 Онови FACEBOOK_COOKIES у Render.",
        
          true
        );
      }

    
      throw new Error(
        "FACEBOOK_AUTH_REQUIRED"
      );
    }

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
   ДІАГНОСТИКА FACEBOOK PAGES.

   Якщо role="article" взагалі немає,
   дивимося, що Facebook реально
   відрендерив на сторінці.
*/

if (articleCount === 0) {

  const zeroArticlesDebug =
    await page.evaluate(() => {

      const bodyText =
        (
          document.body?.innerText ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 2000);


      const allLinks =
        [
          ...document.querySelectorAll(
            "a[href]"
          )
        ]
          .map(a => a.href)
          .filter(Boolean);


      const postLinks =
        [
          ...new Set(
            allLinks.filter(
              href =>
                href.includes("/posts/") ||
                href.includes("/reel/") ||
                href.includes("/videos/") ||
                href.includes("/permalink.php") ||
                href.includes("story_fbid=")
            )
          )
        ]
          .slice(0, 20);


      const dialogTexts =
        [
          ...document.querySelectorAll(
            '[role="dialog"]'
          )
        ]
          .map(node =>
            (
              node.innerText ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 500)
          )
          .filter(Boolean)
          .slice(0, 5);


      const mainText =
        (
          document.querySelector(
            '[role="main"]'
          )?.innerText ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 2000);


      return {
        bodyText,
        mainText,
        postLinks,
        dialogTexts,
        linksCount:
          allLinks.length,

        htmlLength:
          document.documentElement
            ?.outerHTML
            ?.length || 0
      };
    });


  console.log(
    "FACEBOOK ZERO ARTICLES BODY:",
    url,
    zeroArticlesDebug.bodyText
  );


  console.log(
    "FACEBOOK ZERO ARTICLES MAIN:",
    url,
    zeroArticlesDebug.mainText
  );


  console.log(
    "FACEBOOK ZERO ARTICLES POST LINKS:",
    url,
    JSON.stringify(
      zeroArticlesDebug.postLinks
    )
  );


  console.log(
    "FACEBOOK ZERO ARTICLES DIALOGS:",
    url,
    JSON.stringify(
      zeroArticlesDebug.dialogTexts
    )
  );


  console.log(
    "FACEBOOK ZERO ARTICLES STATS:",
    url,
    JSON.stringify({
      linksCount:
        zeroArticlesDebug.linksCount,

      htmlLength:
        zeroArticlesDebug.htmlLength
    })
  );
}
    
    /*
       Деякі Facebook-групи спочатку показують
       тільки loading skeleton замість постів.
    
       Якщо всі знайдені article — loading-state,
       пробуємо прокрутити сторінку і дочекатися
       реального контенту.
    */
    
    if (articleCount > 0) {
    
      const loadingArticleCount =
        await page
          .locator(
            '[role="article"] [data-visualcompletion="loading-state"]'
          )
          .count();
    
    
      console.log(
        "FACEBOOK LOADING ARTICLES:",
        loadingArticleCount,
        "/",
        articleCount
      );
    
    
      if (
        loadingArticleCount >= articleCount
      ) {
    
        console.log(
          "FACEBOOK FEED STILL LOADING:",
          url
        );
    
    
        await page.evaluate(() => {
    
          window.scrollBy(
            0,
            Math.max(
              window.innerHeight,
              900
            )
          );
        });
    
    
        await page.waitForTimeout(
          3000
        );
    
    
        await page.evaluate(() => {
    
          window.scrollBy(
            0,
            Math.max(
              window.innerHeight,
              900
            )
          );
        });
    
    
        try {
    
          await page.waitForFunction(
            () => {
    
              const articles =
                [
                  ...document.querySelectorAll(
                    '[role="article"]'
                  )
                ];
    
    
              return articles.some(
                article => {
    
                  const loading =
                    article.querySelector(
                      '[data-visualcompletion="loading-state"]'
                    );
    
    
                  const text =
                    (
                      article.innerText ||
                      ""
                    ).trim();
    
    
                  const link =
                    article.querySelector(
                      'a[href]'
                    );
    
    
                  return (
                    !loading &&
                    (
                      text.length > 0 ||
                      !!link
                    )
                  );
                }
              );
            },
            null,
            {
              timeout: 10000
            }
          );
    
    
          console.log(
            "FACEBOOK FEED LOADED AFTER RETRY:",
            url
          );
    
        } catch {
    
          console.log(
            "FACEBOOK FEED STILL SKELETON AFTER RETRY:",
            url
          );
        }
    
    
        await page.waitForTimeout(
          1000
        );
      }
    }

    const debugArticles =
      await page.locator(
        '[role="article"]'
      ).evaluateAll(
        nodes =>
          nodes
            .slice(0, 10)
            .map(
              (node, index) => {
    
                const links =
                  [...node.querySelectorAll("a")]
                    .map(a => a.href)
                    .filter(Boolean);
    
                return {
                  index,
                  text:
                    (node.innerText || "")
                      .slice(0, 300),
    
                  links:
                    links.filter(
                      href =>
                        href.includes("/posts/") ||
                        href.includes("/reel/") ||
                        href.includes("/videos/") ||
                        href.includes("/permalink.php") ||
                        href.includes("story_fbid=")
                    )
                };
              }
            )
      );
    
    console.log(
      "FACEBOOK ARTICLES DEBUG:",
      url,
      JSON.stringify(
        debugArticles
      )
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
                    href.includes("/videos/") ||
                    href.includes("/permalink.php") ||
                    href.includes("story_fbid=")
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
                  .flatMap(
                    img => {
              
                      const candidates = [];
              
              
                      /*
                         Поточна URL картинки
                      */
                      if (
                        img.src
                      ) {
                        candidates.push(
                          {
                            url:
                              img.src,
                            score:
                              1
                          }
                        );
                      }
              
              
                      /*
                         currentSrc може бути
                         вже вибраною браузером
                         більшою версією.
                      */
                      if (
                        img.currentSrc
                      ) {
                        candidates.push(
                          {
                            url:
                              img.currentSrc,
                            score:
                              2
                          }
                        );
                      }
              
              
                      /*
                         Facebook часто ховає
                         великі версії у srcset.
                      */
                      const srcset =
                        img.getAttribute(
                          "srcset"
                        ) ||
                        img.getAttribute(
                          "data-srcset"
                        );
              
              
                      if (
                        srcset
                      ) {
              
                        for (
                          const part
                          of srcset.split(",")
                        ) {
              
                          const pieces =
                            part.trim()
                              .split(
                                /\s+/
                              );
              
              
                          const url =
                            pieces[0];
              
              
                          if (
                            !url ||
                            !url.startsWith(
                              "http"
                            )
                          ) {
                            continue;
                          }
              
              
                          let score =
                            3;
              
              
                          const descriptor =
                            pieces[1] ||
                            "";
              
              
                          /*
                             1200w -> score 1200
                             2x    -> score 2000
                          */
                          if (
                            descriptor.endsWith(
                              "w"
                            )
                          ) {
              
                            score =
                              parseFloat(
                                descriptor
                              );
              
                          } else if (
                            descriptor.endsWith(
                              "x"
                            )
                          ) {
              
                            score =
                              parseFloat(
                                descriptor
                              ) * 1000;
                          }
              
              
                          candidates.push(
                            {
                              url,
                              score
                            }
                          );
                        }
                      }
              
              
                      /*
                         data-src — запасний варіант
                      */
                      const dataSrc =
                        img.getAttribute(
                          "data-src"
                        );
              
              
                      if (
                        dataSrc &&
                        dataSrc.startsWith(
                          "http"
                        )
                      ) {
              
                        candidates.push(
                          {
                            url:
                              dataSrc,
                            score:
                              2.5
                          }
                        );
                      }
              
              
                      /*
                         Беремо найбільшу доступну
                         версію картинки.
                      */
                      candidates.sort(
                        (
                          a,
                          b
                        ) =>
                          b.score -
                          a.score
                      );
              
              
                      return candidates.length
                        ? [
                            candidates[0].url
                          ]
                        : [];
                    }
                  )
                  .filter(
                    src =>
                      src &&
                      src.startsWith(
                        "http"
                      )
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

    /*
   Для Reel/video Facebook у стрічці іноді
   віддає не caption поста, а короткий
   сторонній текст.

   Відкриваємо сам Reel і беремо повніший текст.
  */
  
  for (const post of posts) {

    if (!post.postUrl) {
      continue;
    }
  
    /*
     * Для Reel/video забираємо повний текст.
     */
    if (
      post.postUrl.includes("/reel/") ||
      post.postUrl.includes("/videos/")
    ) {
  
      post.text =
        await getFacebookPostFullText(
          context,
          post.postUrl,
          post.text
        );
    }
  
  /*
 * Не відкриваємо кожен звичайний пост вдруге.
 * Це сильно гальмує RSS на Render.
 *
 * Для Reel/video сторінка вже відкривається
 * окремо для отримання повного тексту,
 * тому додатковий пошук картинки залишаємо
 * тільки для них.
 */

const isVideoPost =
  post.postUrl.includes("/reel/") ||
  post.postUrl.includes("/videos/");

if (isVideoPost) {
  post.images =
    await getFacebookPostImages(
      context,
      post.postUrl,
      post.images
    );
}
  }

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
    
    
    /*
       Facebook іноді створює окремі
       [role="article"] для коментарів.
    
       Вони можуть вести на той самий
       /posts/123/, тільки з ?comment_id=...
    
       Після cleanFacebookPostUrl()
       вони мають однаковий postUrl.
    
       Залишаємо один запис на один пост.
       Якщо варіантів декілька —
       беремо той, де більше тексту.
    */
    
    const uniquePosts =
      new Map();
    
    
    for (
      const post
      of cleanedPosts
    ) {
    
      /*
         Якщо Facebook URL немає,
         використовуємо текст як fallback.
      */
    
      const key =
        post.postUrl ||
        post.text.slice(0, 200);
    
    
      const previous =
        uniquePosts.get(
          key
        );
    
    
      if (
        !previous ||
        post.text.length >
          previous.text.length
      ) {
    
        uniquePosts.set(
          key,
          post
        );
      }
    }
    
    
    return [
      ...uniquePosts.values()
    ];


  } catch (error) {
    
      console.log(
        "FACEBOOK SCRAPE ERROR:",
        url,
        String(error)
      );
    
    
      if (
        String(error).includes(
          "FACEBOOK_AUTH_REQUIRED"
        )
      ) {
    
        throw error;
      }
    
    
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
      let downloadUrl =
        imageUrl;
      
      try {
      
        const parsedImage =
          new URL(
            imageUrl
          );
      
        const originalUrl =
          parsedImage.searchParams.get(
            "url"
          );
      
        if (
          originalUrl
        ) {
      
          downloadUrl =
            originalUrl;
      
          console.log(
            "IMAGE PROXY ORIGINAL URL:",
            downloadUrl
          );
        }
      
      } catch {
      }
            
      const response =
        await context.request.get(
          downloadUrl,
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
          downloadUrl
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


// Перший запит, коли готового кешу немає.

const feedId = String(source.id);

// Запускаємо створення кешу,
// якщо воно ще не виконується.
updateFeedCache(source).catch(error => {
  console.error(
    "FIRST CACHE ERROR:",
    feedId,
    error
  );
});

// Не тримаємо HTTP-запит відкритим 30 секунд.
// Клієнт зможе повторити запит пізніше.
res.set(
  "Cache-Control",
  "no-store"
);

res.set(
  "Retry-After",
  "20"
);

res.set(
  "X-RSS-Cache",
  "WARMING"
);

return res.status(503).json({
  ok: false,
  warming: true,
  feed: feedId,
  retryAfter: 20,
  message: "RSS cache is warming up"
});
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

    // Прогріваємо RSS послідовно.
// Не ставимо всі джерела в чергу одночасно.

setTimeout(() => {
  console.log("STARTING RSS CACHE WARMUP");

  (async () => {
    for (const source of SOURCES) {

      // Якщо джерело вже готове,
      // повторно його не обробляємо.
      if (rssCache.has(String(source.id))) {
        continue;
      }

      try {
        console.log(
          "WARMUP FEED:",
          source.id
        );

        await updateFeedCache(source);

      } catch (error) {
        console.error(
          "WARMUP ERROR:",
          source.id,
          error
        );
      }

      // Невелика пауза між джерелами.
      await new Promise(resolve =>
        setTimeout(resolve, 1000)
      );
    }

    console.log("RSS CACHE WARMUP FINISHED");

  })().catch(error => {
    console.error(
      "RSS WARMUP FAILED:",
      error
    );
  });

}, 5000);
    
    
    
    
    /*
     * Потім перевіряємо
     * Facebook-сесію раз на годину.
     */
    
    setInterval(
      () => {
    
        checkFacebookAuth()
          .catch(
            error =>
              console.log(
                "FACEBOOK AUTH CHECK ERROR:",
                String(error)
              )
          );
    
      },
      60 * 60 * 1000
    );
    
      }
    );
