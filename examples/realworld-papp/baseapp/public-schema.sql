-- CreateTable
CREATE TABLE IF NOT EXISTS `blog_user` (
    `id` VARCHAR(255) NOT NULL,
    `bio` VARCHAR(191) NULL,
    `image` VARCHAR(191) NULL,
    `username` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `blog_user_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `blog_follows` (
    `follower_id` VARCHAR(255) NOT NULL,
    `following_id` VARCHAR(255) NOT NULL,

    PRIMARY KEY (`follower_id`, `following_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `blog_article` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `author_id` VARCHAR(255) NOT NULL,
    `del` BOOLEAN NOT NULL DEFAULT false,
    `favorites_count` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `blog_article_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `blog_favorites` (
    `article_id` INTEGER NOT NULL,
    `user_id` VARCHAR(255) NOT NULL,

    PRIMARY KEY (`article_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `blog_comment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `body` VARCHAR(1024) NOT NULL,
    `article_id` INTEGER NOT NULL,
    `author_id` VARCHAR(255) NOT NULL,
    `del` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `blog_articles_tags` (
    `article_id` INTEGER NOT NULL,
    `tag_id` INTEGER NOT NULL,

    PRIMARY KEY (`article_id`, `tag_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `blog_tag` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `blog_tag_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `blog_follows` ADD CONSTRAINT `blog_follows_follower_id_fkey` FOREIGN KEY (`follower_id`) REFERENCES `blog_user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blog_follows` ADD CONSTRAINT `blog_follows_following_id_fkey` FOREIGN KEY (`following_id`) REFERENCES `blog_user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blog_article` ADD CONSTRAINT `blog_article_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `blog_user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blog_favorites` ADD CONSTRAINT `blog_favorites_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `blog_article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blog_favorites` ADD CONSTRAINT `blog_favorites_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `blog_user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blog_comment` ADD CONSTRAINT `blog_comment_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `blog_article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blog_comment` ADD CONSTRAINT `blog_comment_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `blog_user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blog_articles_tags` ADD CONSTRAINT `blog_articles_tags_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `blog_article`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `blog_articles_tags` ADD CONSTRAINT `blog_articles_tags_tag_id_fkey` FOREIGN KEY (`tag_id`) REFERENCES `blog_tag`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

