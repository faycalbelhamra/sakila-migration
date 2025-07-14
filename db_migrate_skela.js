// migration.js

const { Client } = require('pg');
const redis = require('redis');
const { MongoClient } = require('mongodb');

// --- Database Configuration ---
const pgConfig = {
    user: 'your_pg_user',
    host: 'localhost',
    database: 'sakila_pg', // The PostgreSQL database name you created
    password: 'your_pg_password',
    port: 5432,
};

const redisConfig = {
    host: 'localhost',
    port: 6379,
};

const mongoConfig = {
    uri: 'mongodb://localhost:27017',
    dbName: 'sakila_nosql', // The MongoDB database name
};

async function runMigration() {
    let pgClient;
    let redisClient;
    let mongoDb;
    let mongoClient;

    try {
        // --- 1. Connect to Databases ---
        pgClient = new Client(pgConfig);
        await pgClient.connect();
        console.log('Connected to PostgreSQL');

        redisClient = redis.createClient(redisConfig);
        await redisClient.connect(); // Connect to Redis
        console.log('Connected to Redis');

        mongoClient = new MongoClient(mongoConfig.uri);
        await mongoClient.connect();
        mongoDb = mongoClient.db(mongoConfig.dbName);
        console.log('Connected to MongoDB');

        // Clear existing data in NoSQL databases for a clean migration (Optional)
        await redisClient.flushDb(); // Use with caution in production!
        console.log('Redis flushed.');
        await mongoDb.collection('films').deleteMany({});
        await mongoDb.collection('actors').deleteMany({});
        console.log('MongoDB collections cleared.');

        // --- 2. Migrate Country and City to Redis ---
        await migrateCountriesToRedis(pgClient, redisClient);
        await migrateCitiesToRedis(pgClient, redisClient);

        // --- 3. Migrate Language, Category, Actor, Film to MongoDB ---
        // Fetch lookup data first
        const languagesMap = await fetchLanguages(pgClient);
        const categoriesMap = await fetchCategories(pgClient);

        await migrateActorsToMongoDB(pgClient, mongoDb);
        await migrateFilmsToMongoDB(pgClient, mongoDb, languagesMap, categoriesMap);

        console.log('\nMigration complete!');

    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        // --- Close Connections ---
        if (pgClient) {
            await pgClient.end();
            console.log('PostgreSQL connection closed.');
        }
        if (redisClient) {
            await redisClient.quit();
            console.log('Redis connection closed.');
        }
        if (mongoClient) {
            await mongoClient.close();
            console.log('MongoDB connection closed.');
        }
    }
}

// --- PostgreSQL Data Fetching Functions ---

async function fetchCountries(pgClient) {
    const res = await pgClient.query('SELECT country_id, country, last_update FROM country');
    return res.rows;
}

async function fetchCities(pgClient) {
    const res = await pgClient.query('SELECT city_id, city, country_id, last_update FROM city');
    return res.rows;
}

async function fetchLanguages(pgClient) {
    const res = await pgClient.query('SELECT language_id, name, last_update FROM language');
    const languagesMap = {};
    res.rows.forEach(lang => {
        languagesMap[lang.language_id] = {
            id: lang.language_id,
            name: lang.name
        };
    });
    return languagesMap;
}

async function fetchCategories(pgClient) {
    const res = await pgClient.query('SELECT category_id, name, last_update FROM category');
    const categoriesMap = {};
    res.rows.forEach(cat => {
        categoriesMap[cat.category_id] = {
            id: cat.category_id,
            name: cat.name
        };
    });
    return categoriesMap;
}

async function fetchActors(pgClient) {
    const res = await pgClient.query('SELECT actor_id, first_name, last_name, last_update FROM actor');
    return res.rows;
}

async function fetchFilms(pgClient) {
    // Join with language and potentially film_category/film_actor for initial data collection
    const query = `
        SELECT
            f.film_id, f.title, f.description, f.release_year,
            f.rental_duration, f.rental_rate, f.length, f.replacement_cost,
            f.rating, f.special_features, f.last_update,
            f.language_id,
            f.original_language_id, -- Keep original_language_id if needed
            STRING_AGG(DISTINCT fc.category_id::text, ',') AS category_ids,
            STRING_AGG(DISTINCT fa.actor_id::text, ',') AS actor_ids
        FROM film f
        LEFT JOIN film_category fc ON f.film_id = fc.film_id
        LEFT JOIN film_actor fa ON f.film_id = fa.film_id
        GROUP BY f.film_id
        ORDER BY f.film_id;
    `;
    const res = await pgClient.query(query);
    return res.rows;
}

// --- Redis Migration Functions ---

async function migrateCountriesToRedis(pgClient, redisClient) {
    console.log('Migrating Countries to Redis...');
    const countries = await fetchCountries(pgClient);
    for (const country of countries) {
        // Using HASH for country details
        await redisClient.hSet(`country:${country.country_id}`, {
            country_id: country.country_id.toString(),
            country_name: country.country,
            last_update: country.last_update.toISOString(),
        });
    }
    console.log(`Migrated ${countries.length} countries to Redis.`);
}

async function migrateCitiesToRedis(pgClient, redisClient) {
    console.log('Migrating Cities to Redis...');
    const cities = await fetchCities(pgClient);
    for (const city of cities) {
        // Using HASH for city details
        await redisClient.hSet(`city:${city.city_id}`, {
            city_id: city.city_id.toString(),
            city_name: city.city,
            country_id: city.country_id.toString(), // Store foreign key
            last_update: city.last_update.toISOString(),
        });
    }
    console.log(`Migrated ${cities.length} cities to Redis.`);
}

// --- MongoDB Migration Functions ---

async function migrateActorsToMongoDB(pgClient, mongoDb) {
    console.log('Migrating Actors to MongoDB...');
    const actors = await fetchActors(pgClient);
    const actorDocs = actors.map(actor => ({
        _id: actor.actor_id,
        first_name: actor.first_name,
        last_name: actor.last_name,
        last_update: actor.last_update,
    }));
    if (actorDocs.length > 0) {
        await mongoDb.collection('actors').insertMany(actorDocs);
    }
    console.log(`Migrated ${actors.length} actors to MongoDB.`);
}

async function migrateFilmsToMongoDB(pgClient, mongoDb, languagesMap, categoriesMap) {
    console.log('Migrating Films to MongoDB...');
    const films = await fetchFilms(pgClient);
    const filmDocs = [];

    for (const film of films) {
        const categories = film.category_ids ? film.category_ids.split(',').map(id => categoriesMap[parseInt(id)]) : [];
        const actorIds = film.actor_ids ? film.actor_ids.split(',').map(id => parseInt(id)) : [];

        const filmDoc = {
            _id: film.film_id,
            title: film.title,
            description: film.description,
            release_year: film.release_year,
            rental_duration: film.rental_duration,
            rental_rate: film.rental_rate,
            length: film.length,
            replacement_cost: film.replacement_cost,
            rating: film.rating,
            special_features: film.special_features ? film.special_features.split(',') : [],
            last_update: film.last_update,
            language: languagesMap[film.language_id], // Embedded language
            // original_language: film.original_language_id ? languagesMap[film.original_language_id] : null, // Optional
            categories: categories.filter(Boolean), // Embedded categories
            actors: actorIds, // Referenced actor IDs
        };
        filmDocs.push(filmDoc);
    }

    if (filmDocs.length > 0) {
        await mongoDb.collection('films').insertMany(filmDocs);
    }
    console.log(`Migrated ${films.length} films to MongoDB.`);
}

// Execute the migration
runMigration();