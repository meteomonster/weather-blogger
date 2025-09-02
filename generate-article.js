/* ... (Existing code for imports, API key, and utilities) ... */

// 4) NEW: Fetch global extreme weather events
async function getGlobalEvents() {
    const today = new Date();
    const isoDate = today.toISOString().split('T')[0];
    
    // Placeholder for fetching data from different APIs
    try {
        // Example: Fetch hurricane data from a hypothetical API
        // const hurrResponse = await axios.get(`https://api.example.com/hurricanes?date=${isoDate}`);
        // const hurricanes = hurrResponse.data.events;

        // Example: Fetch earthquake data from USGS
        const eqResponse = await axios.get(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${isoDate}T00:00:00&endtime=${isoDate}T23:59:59&minmagnitude=6.0`);
        const earthquakes = eqResponse.data.features.map(f => ({
            magnitude: f.properties.mag,
            location: f.properties.place,
            time: new Date(f.properties.time)
        }));

        // Return a structured object
        return {
            hurricanes: [], // Populate this with real data
            tornadoes: [], // Populate this with real data
            earthquakes: earthquakes
        };
    } catch (error) {
        console.error("Failed to fetch global event data:", error.message);
        return { hurricanes: [], tornadoes: [], earthquakes: [] };
    }
}

/* ... (Existing code for getWeatherData, getHistoricalRecord, and buildDateLabels) ... */

// 7) Updated generateArticle function
async function generateArticle(weatherData, timeOfDayRu) {
    const tz = "Europe/Riga";
    const dates = buildDateLabels(weatherData.time);
    const todayRiga = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
    const historicalRecord = await getHistoricalRecord(new Date(Date.UTC(
        todayRiga.getFullYear(),
        todayRiga.getMonth(),
        todayRiga.getDate()
    )));
    
    // NEW: Fetch and prepare global event data
    const globalEvents = await getGlobalEvents();
    const hasExtremeEvents = globalEvents.earthquakes.length > 0 || globalEvents.hurricanes.length > 0 || globalEvents.tornadoes.length > 0;
    const globalEventsText = hasExtremeEvents
        ? `
<GLOBAL_EVENTS>
Землетрясения: ${globalEvents.earthquakes.map(eq => `Магнитуда ${eq.magnitude.toFixed(1)} в районе ${eq.location}`).join(', ')}.
Ураганы/тайфуны: ${globalEvents.hurricanes.length > 0 ? 'Название, Категория, Местоположение.' : 'Нет крупных ураганов.'}
Торнадо: ${globalEvents.tornadoes.length > 0 ? 'Местоположение, Сила.' : 'Нет крупных торнадо.'}
</GLOBAL_EVENTS>
`
        : "<GLOBAL_EVENTS>Нет заметных экстремальных погодных событий в мире.</GLOBAL_EVENTS>";

    const dataPayload = { /* ... (same as before) ... */ };

    const prompt = `
Твоя роль: Опытный и харизматичный метеоролог, который ведёт популярный блог о погоде в Риге. Твой стиль — дружелюбный, образный и слегка ироничный, но при этом технически безупречный и профессионально точный. Ты объясняешь сложные процессы простым языком, используя метафоры к месту и не перегружая текст.

Твоя задача: Написать эксклюзивный синоптический обзор для читателей блога, уделяя внимание не только местной, но и глобальной картине погоды. Сейчас нужно подготовить ${timeOfDayRu} выпуск.

СТРОГИЕ ПРАВИЛА:
1. Используй только предоставленные данные. Не придумывай и не изменяй цифры, даты или факты.
2. Никакого Markdown: не используй символы ##, **, * или любые другие. Только чистый текст.
3. Только реальные даты: не используй "1-й день", "2-й день". Применяй даты из блока данных.
4. Подзаголовки: каждый подзаголовок на отдельной строке, после него — одна пустая строка.
5. Не выводи отдельную строку с датой под заголовком. Заголовок — одна строка, затем сразу текст.
6. Безупречная грамотность русского языка, аккуратные предлоги и числительные.
7. Объём выпуска: 700–1100 слов. Каждый раздел должен быть содержательным, без воды.

СТРУКТУРА СТАТЬИ:
Заголовок
Вступление
Обзор погоды с высоты птичьего полёта (глобальная и местная картина)
Детальный прогноз по дням
Почему так, а не иначе
Совет от метеоролога
Мини-рубрика "А вы знали, что..."
Мини-рубрика "Сегодня в истории"
Мини-рубрика "Примета дня"
Завершение

ДЕТАЛИ СОДЕРЖАНИЯ:
— Обзор погоды: Сначала кратко опиши заметные экстремальные события в мире, используя данные из <GLOBAL_EVENTS>. Затем плавно перейди к местной картине в Риге. Объясни, как общая атмосферная циркуляция влияет на нашу погоду, например, как барические центры, управляющие глобальными процессами, формируют наше местное синоптическое поле. Опиши происхождение и положение барических центров (циклон/антициклон), связанные фронты, адвекцию воздушных масс (откуда и куда идёт воздух), барический градиент и его влияние на ветер, роль Балтийского моря и суши. Укажи, как это отразится на температуре, облачности, вероятности и характере осадков, видимости, ветре и его порывах.
— Детальный прогноз по дням: для каждого из ближайших дней используй минимум 4–6 предложений. Дай ощущение «живого» дня: утро/день/вечер/ночь (если уместно), когда возможны «световые окна» без осадков, где погода будет комфортна (например, для прогулки у воды или парка), отметь направление ветра словами (используй компасные стороны из данных), укажи порывы, если они заметные (≥10 м/с), и крупные колебания облачности.
— Почему так, а не иначе: объясни механику происходящего простым языком (на уровне популярной метеорологии), 5–7 предложений.
— Совет от метеоролога: 3–5 практических рекомендаций одним цельным абзацем (одежда/зонт/планирование дел/прогулки/велосипед/у воды и т.п.). Учти подсказки ниже.
— "А вы знали, что...": один интересный факт из общей метеорологии (без цифр, которых нет в данных).
— "Сегодня в истории": используй ровно этот текст — он уже готов и проверен.
— "Примета дня": короткая народная примета + короткое научное пояснение, почему она может работать.
— Избегай сухих перечислений. Пиши живо и образно, но без перегруза.

Подсказки для раздела "Совет от метеоролога":
${advisoryHints.join(" ") || "Особых погодных рисков не ожидается, сделай акцент на комфорте и планировании активностей."}

ДАННЫЕ (не выводить в ответ, использовать только для анализа):

<DATA_JSON>
${JSON.stringify(dataPayload)}
</DATA_JSON>

<GLOBAL_EVENTS>
${globalEventsText}
</GLOBAL_EVENTS>

<NOTE>
Сегодня в истории: ${historicalRecord}
</NOTE>
`;

    // ... (rest of the function remains the same) ...
}
