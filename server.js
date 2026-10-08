import express from "express";
import { chromium } from "playwright";
import fs from "fs/promises";
import { createClient } from "@libsql/client";

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

function maximizeFacebookImageUrl(
  rawUrl
) {

  const url =
    String(rawUrl || "");

  if (
    !url ||
    !url.includes("fbcdn.net")
  ) {
    return url;
  }


  const maxSize =
    url.match(
      /(?:[?&]|%26)cstp=mx(\d+)x(\d+)/i
    ) ||

    url.match(
      /(?:[?&]|%26)stp=[^&]*?mx(\d+)x(\d+)/i
    );


  if (
    !maxSize
  ) {
    return url;
  }


  const width =
    maxSize[1];

  const height =
    maxSize[2];


  return url.replace(
    /([?&]ctp=)s\d+x\d+/i,
    `$1s${width}x${height}`
  );
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

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function restoreRssCache() {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS rss_cache (
      feed_id TEXT PRIMARY KEY,
      rss TEXT NOT NULL,
      posts INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const result = await turso.execute(
    "SELECT * FROM rss_cache"
  );

  for (const row of result.rows) {
    rssCache.set(String(row.feed_id), {
      rss: String(row.rss),
      posts: Number(row.posts),
      updatedAt: Number(row.updated_at)
    });
  }

  console.log("TURSO RSS RESTORED:", result.rows.length);
}

async function saveRssCache(id, entry) {
  await turso.execute({
    sql: `
      INSERT INTO rss_cache
        (feed_id, rss, posts, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET
        rss = excluded.rss,
        posts = excluded.posts,
        updated_at = excluded.updated_at
    `,
    args: [
      String(id),
      entry.rss,
      entry.posts,
      entry.updatedAt
    ]
  });
}

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

      try {
        await saveRssCache(id, entry);
        console.log("TURSO RSS SAVED:", id);
      } catch (error) {
        console.error("TURSO SAVE ERROR:", id, error);
      }

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
        "✅ Facebook-сесію на Render відновлено. RSS знову можуть читати джерела, які потребують авторизації"
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

    page =
      await context.newPage();


    console.log(
      "FACEBOOK OPEN POST FOR ORIGINAL IMAGES:",
      postUrl
    );


    try {

      await page.goto(
        postUrl,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            20000
        }
      );

    } catch (error) {

      console.log(
        "FACEBOOK ORIGINAL IMAGES GOTO TIMEOUT:",
        postUrl,
        String(error)
      );
    }


    await page.waitForTimeout(
      2500
    );


    /*
       Шукаємо картинки саме всередині
       Facebook article поста.

       Не скануємо весь HTML сторінки,
       тому аватарки, рекомендації,
       реклама та сусідні Reel сюди
       не повинні потрапляти.
    */
    const imageDebug =
      await page.evaluate(() => {
    
        const html =
          document.documentElement.outerHTML;
    
    
        const needle =
          "833993803_1441317284611955_3450432627548124986";
    
    
        const index =
          html.indexOf(
            needle
          );
    
    
        if (index === -1) {
    
          return {
            found: false
          };
        }
    
    
        return {
          found: true,
    
          index,
    
          around:
            html.slice(
              Math.max(
                0,
                index - 3000
              ),
              index + 3000
            )
        };
      });
    
    
    console.log(
      "FACEBOOK TARGET IMAGE DEBUG:",
      JSON.stringify(
        imageDebug
      )
    );
    
    const postImages =
      await page.evaluate(() => {

        const articles =
          [
            ...document.querySelectorAll(
              '[role="article"]'
            )
          ];


        /*
           Спочатку шукаємо article,
           в якому є permalink поточного поста.

           Якщо Facebook відкрив пост
           у modal/dialog — перший нормальний
           article зазвичай і є потрібним.
        */

        let targetArticle =
          null;


        for (
          const article
          of articles
        ) {

          const links =
            [
              ...article.querySelectorAll(
                "a[href]"
              )
            ]
              .map(
                link =>
                  link.href || ""
              );


          const hasPostLink =
            links.some(
              href =>
                href.includes(
                  "/posts/"
                ) ||
                href.includes(
                  "/permalink.php"
                ) ||
                href.includes(
                  "story_fbid="
                ) ||
                href.includes(
                  "/reel/"
                ) ||
                href.includes(
                  "/videos/"
                )
            );


          if (hasPostLink) {

            targetArticle =
              article;

            break;
          }
        }


        /*
           Якщо permalink Facebook
           у DOM не залишив —
           беремо найбільший article.

           Коментарі зазвичай значно менші.
        */

        if (!targetArticle) {

          const ranked =
            articles
              .map(
                article => ({
                  article,

                  score:
                    (
                      article.innerText ||
                      ""
                    ).length +
                    article.querySelectorAll(
                      "img"
                    ).length * 500
                })
              )
              .sort(
                (a, b) =>
                  b.score -
                  a.score
              );


          targetArticle =
            ranked[0]?.article ||
            null;
        }


        if (!targetArticle) {

          return [];
        }


        const result =
          [];


        const images =
          [
            ...targetArticle.querySelectorAll(
              "img"
            )
          ];


        for (
          const img
          of images
        ) {

          const rect =
            img.getBoundingClientRect();


          const naturalWidth =
            Number(
              img.naturalWidth || 0
            );


          const naturalHeight =
            Number(
              img.naturalHeight || 0
            );


          /*
             Відсікаємо аватарки,
             іконки та дрібні картинки.
          */

          if (
            (
              naturalWidth > 0 &&
              naturalWidth < 300
            ) ||
            (
              naturalHeight > 0 &&
              naturalHeight < 300
            )
          ) {

            continue;
          }


          if (
            rect.width > 0 &&
            rect.height > 0 &&
            (
              rect.width < 200 ||
              rect.height < 200
            )
          ) {

            continue;
          }


          const candidates =
            [];


          /*
             src
          */

          const src =
            img.getAttribute(
              "src"
            );


          if (
            src &&
            src.startsWith(
              "http"
            )
          ) {

            candidates.push({
              url:
                src,

              score:
                naturalWidth *
                naturalHeight
            });
          }


          /*
             currentSrc
          */

          if (
            img.currentSrc &&
            img.currentSrc.startsWith(
              "http"
            )
          ) {

            candidates.push({
              url:
                img.currentSrc,

              score:
                naturalWidth *
                naturalHeight +
                1
            });
          }


          /*
             srcset.

             Саме тут Facebook може
             тримати більшу версію,
             ніж поточний src.
          */

          const srcset =
            img.getAttribute(
              "srcset"
            ) ||
            img.getAttribute(
              "data-srcset"
            );


          if (srcset) {

            for (
              const part
              of srcset.split(",")
            ) {

              const pieces =
                part
                  .trim()
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


              const descriptor =
                pieces[1] ||
                "";


              let score =
                naturalWidth *
                naturalHeight;


              if (
                descriptor.endsWith(
                  "w"
                )
              ) {

                const width =
                  parseFloat(
                    descriptor
                  );


                if (
                  Number.isFinite(
                    width
                  )
                ) {

                  score =
                    width *
                    width;
                }

              } else if (
                descriptor.endsWith(
                  "x"
                )
              ) {

                const scale =
                  parseFloat(
                    descriptor
                  );


                if (
                  Number.isFinite(
                    scale
                  )
                ) {

                  score =
                    naturalWidth *
                    naturalHeight *
                    scale *
                    scale;
                }
              }


              candidates.push({
                url,
                score:
                  score + 10
              });
            }
          }


          /*
             data-src
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

            candidates.push({
              url:
                dataSrc,

              score:
                naturalWidth *
                naturalHeight +
                5
            });
          }


          /*
             Іноді сама картинка загорнута
             у посилання на Facebook photo.

             URL картинки все одно беремо
             з img/src/srcset, але такий
             елемент отримує великий бонус,
             бо це майже напевно медіа поста.
          */

          const parentLink =
            img.closest(
              "a[href]"
            );


          const parentHref =
            parentLink?.href ||
            "";


          const photoBonus =
            (
              parentHref.includes(
                "/photo"
              ) ||
              parentHref.includes(
                "fbid="
              )
            )
              ? 1000000000000
              : 0;


          for (
            const candidate
            of candidates
          ) {

            if (
              !candidate.url.includes(
                "fbcdn.net"
              )
            ) {

              continue;
            }


            /*
               Facebook profile pictures
               часто мають тип -1 у URL.

               Не забороняємо жорстко,
               але сильно знижуємо рейтинг.
            */

            let penalty =
              0;


            if (
              candidate.url.includes(
                "t39.30808-1"
              )
            ) {

              penalty +=
                500000000000;
            }


            if (
              candidate.url.includes(
                "s40x40"
              ) ||
              candidate.url.includes(
                "s160x160"
              )
            ) {

              penalty +=
                500000000000;
            }


            result.push({
              url:
                candidate.url,

              score:
                candidate.score +
                photoBonus -
                penalty,

              naturalWidth,

              naturalHeight,

              renderedWidth:
                Math.round(
                  rect.width
                ),

              renderedHeight:
                Math.round(
                  rect.height
                ),

              parentHref
            });
          }
        }


        /*
           Найкращі кандидати першими.
        */

        result.sort(
          (a, b) =>
            b.score -
            a.score
        );


        /*
           Прибираємо дублікати.
        */

        const unique =
          [];


        const seen =
          new Set();


        for (
          const item
          of result
        ) {

          if (
            seen.has(
              item.url
            )
          ) {

            continue;
          }


          seen.add(
            item.url
          );


          unique.push(
            item
          );
        }


        return unique;
      });


    console.log(
      "FACEBOOK POST IMAGE CANDIDATES:",
      postUrl,
      JSON.stringify(
        postImages.slice(
          0,
          10
        )
      )
    );


    /*
       /post-images та RSS очікують
       масив URL, тому назовні
       повертаємо тільки адреси.

       У логах Render при цьому
       залишаються розміри та score.
    */

    const originalImages =
      postImages
        .map(
          item =>
            item.url
        )
        .filter(Boolean);


    console.log(
      "FACEBOOK ORIGINAL IMAGES FOUND:",
      originalImages.length
    );


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

      } catch {
      }
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
              const images = [
                ...node.querySelectorAll("img")
              ]
                .flatMap(img => {
                  const candidates = [];
              
                  const addCandidate = (imageUrl, bonus = 0) => {
                    if (!imageUrl || !imageUrl.startsWith("http")) {
                      return;
                    }
              
                    let cleanUrl = imageUrl.replace(/&amp;/g, "&");

                    /*
                       Для external Facebook preview
                       беремо оригінальну картинку з url=.
                    */
                    try {
                      const parsedUrl = new URL(cleanUrl);
                    
                      if (
                        parsedUrl.hostname.includes("external-") &&
                        parsedUrl.hostname.endsWith(".fbcdn.net")
                      ) {
                        const originalUrl =
                          parsedUrl.searchParams.get("url");
                    
                        if (
                          originalUrl &&
                          originalUrl.startsWith("http")
                        ) {
                          cleanUrl = originalUrl;
                        }
                      }
                    } catch {
                    }
              
                    let width = 0;
                    let height = 0;
              
                    /*
                       Facebook часто пише максимальний
                       розмір прямо в URL:
              
                       cstp=mx1365x2048
                       cstp=mx2048x1365
                       cstp=mx512x640
                    */
                    const maxSize =
                      cleanUrl.match(/(?:[?&]|%26)cstp=mx(\d+)x(\d+)/i) ||
                      cleanUrl.match(/(?:[?&]|%26)stp=[^&]*?mx(\d+)x(\d+)/i) ||
                      cleanUrl.match(/mx(\d+)x(\d+)/i);
              
                    if (maxSize) {
                      width = Number(maxSize[1]) || 0;
                      height = Number(maxSize[2]) || 0;
                    }
              
                    /*
                       Якщо mx немає — дивимось ctp:
                       ctp=s512x640
                       ctp=s590x590
                    */
                    if (!width || !height) {
                      const currentSize =
                        cleanUrl.match(/(?:[?&]|%26)ctp=s(\d+)x(\d+)/i);
              
                      if (currentSize) {
                        width = Number(currentSize[1]) || 0;
                        height = Number(currentSize[2]) || 0;
                      }
                    }
              
                    /*
                       Якщо розмір у URL не вказаний —
                       беремо natural size.
                    */
                    if (!width || !height) {
                      width = Number(img.naturalWidth || 0);
                      height = Number(img.naturalHeight || 0);
                    }
              
                    let score = bonus;
              
                    if (width > 0 && height > 0) {
                      score += width * height;
                    }
              
                    if (width >= 500 && height >= 500) {
                      score += 100000000;
                    }
              
                    if (width >= 1000 || height >= 1000) {
                      score += 200000000;
                    }
              
                    /*
                       Аватарки та дрібні thumbnail
                       сильно знижуємо в рейтингу.
                    */
                    if (cleanUrl.includes("t39.30808-1")) {
                      score -= 500000000;
                    }
              
                    if (
                      cleanUrl.includes("s40x40") ||
                      cleanUrl.includes("s60x60") ||
                      cleanUrl.includes("s80x80") ||
                      cleanUrl.includes("s100x100") ||
                      cleanUrl.includes("s160x160")
                    ) {
                      score -= 500000000;
                    }
              
                    if (
                      cleanUrl.includes("static.xx.fbcdn.net") ||
                      cleanUrl.includes("/emoji.php")
                    ) {
                      score -= 1000000000;
                    }
              
                    candidates.push({
                      url: cleanUrl,
                      width,
                      height,
                      score
                    });
                  };
              
                  /*
                     src
                  */
                  addCandidate(
                    img.getAttribute("src") || img.src || "",
                    1
                  );
              
                  /*
                     currentSrc
                  */
                  addCandidate(
                    img.currentSrc || "",
                    10
                  );
              
                  /*
                     data-src
                  */
                  addCandidate(
                    img.getAttribute("data-src") || "",
                    5
                  );
              
                  /*
                     srcset / data-srcset
                  */
                  const srcset =
                    img.getAttribute("srcset") ||
                    img.getAttribute("data-srcset");
              
                  if (srcset) {
                    for (const part of srcset.split(",")) {
                      const pieces =
                        part.trim().split(/\s+/);
              
                      const candidateUrl = pieces[0];
              
                      if (
                        !candidateUrl ||
                        !candidateUrl.startsWith("http")
                      ) {
                        continue;
                      }
              
                      const descriptor = pieces[1] || "";
              
                      let bonus = 20;
              
                      if (descriptor.endsWith("w")) {
                        const value = parseFloat(descriptor);
              
                        if (Number.isFinite(value)) {
                          bonus += value;
                        }
              
                      } else if (descriptor.endsWith("x")) {
                        const value = parseFloat(descriptor);
              
                        if (Number.isFinite(value)) {
                          bonus += value * 1000;
                        }
                      }
              
                      addCandidate(
                        candidateUrl,
                        bonus
                      );
                    }
                  }
              
                  /*
                     Прибираємо дублікати одного img.
                  */
                  const uniqueCandidates = new Map();
              
                  for (const candidate of candidates) {
                    const previous =
                      uniqueCandidates.get(candidate.url);
              
                    if (
                      !previous ||
                      candidate.score > previous.score
                    ) {
                      uniqueCandidates.set(
                        candidate.url,
                        candidate
                      );
                    }
                  }
              
                  /*
                     Беремо найкращу версію цього img.
                  */
                  const best = [
                    ...uniqueCandidates.values()
                  ].sort(
                    (a, b) => b.score - a.score
                  )[0];
              
                  if (!best) {
                    return [];
                  }
              
                  /*
                     Відсікаємо очевидну дрібноту.
                  */
                  if (
                    best.width > 0 &&
                    best.height > 0 &&
                    best.width < 300 &&
                    best.height < 300
                  ) {
                    return [];
                  }
              
                  return [best];
                })
              
                /*
                   Сортуємо картинки самого поста.
                   Великі версії будуть першими.
                */
                .sort(
                  (a, b) => b.score - a.score
                )
              
                .map(image => image.url)
              
                .filter(
                  src =>
                    src &&
                    src.startsWith("http")
                );
              
              
              return {
                text,
                postUrl,
                images: [...new Set(images)]
              };


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

const isPhotoPost =
  !post.postUrl.includes("/reel/") &&
  !post.postUrl.includes("/videos/");

const hasLowQualityImages =
  isPhotoPost &&
  Array.isArray(post.images) &&
  post.images.length > 0 &&
  post.images.some(image => {
    const value =
      String(image || "");

    const size =
      value.match(/(?:[?&]|%26)cstp=mx(\d+)x(\d+)/i) ||
      value.match(/(?:[?&]|%26)stp=[^&]*?mx(\d+)x(\d+)/i) ||
      value.match(/mx(\d+)x(\d+)/i) ||
      value.match(/(?:[?&]|%26)ctp=s(\d+)x(\d+)/i);

    if (!size) {
      return true;
    }

    const width =
      Number(size[1]) || 0;

    const height =
      Number(size[2]) || 0;

    return (
      width > 0 &&
      height > 0 &&
      Math.max(width, height) < 1000
    );
  });

if (hasLowQualityImages) {
  post.images =
    await getFacebookPostImages(
      context,
      post.postUrl,
      post.images
    );
}

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
                `<img src="${escapeXml(
                  maximizeFacebookImageUrl(
                    image
                  )
                )}">`
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
   FACEBOOK POST IMAGES
========================================================= */

app.get(
  "/post-images",
  async (
    req,
    res
  ) => {

    const postUrl =
      String(
        req.query.url || ""
      ).trim();


    if (
      !postUrl ||
      !postUrl.startsWith(
        "https://www.facebook.com/"
      )
    ) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid Facebook post URL required"
        });
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
         Додаємо ті самі Facebook cookies,
         які використовує RSS.
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


      console.log(
        "POST IMAGES:",
        postUrl
      );


      /*
         Тут НЕ робимо page.goto().

         Сторінку поста відкриває
         існуюча getFacebookPostImages().

         Тобто пост відкривається
         тільки один раз.
      */

      const images =
        await getFacebookPostImages(
          context,
          postUrl,
          []
        );


      console.log(
        "POST IMAGES RESULT:",
        postUrl,
        images.length
      );


      return res.json({
        ok: true,

        postUrl,

        count:
          images.length,

        images
      });


    } catch (error) {

      console.log(
        "POST IMAGES ERROR:",
        String(error)
      );


      return res
        .status(500)
        .json({
          ok: false,

          error:
            String(error)
        });


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

await restoreRssCache();
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
