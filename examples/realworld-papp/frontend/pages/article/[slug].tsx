import { useRouter } from 'next/router';
import { useArticleQuery } from '../../generated/graphql';
import LoadingSpinner from '../../../baseapp/components/common/LoadingSpinner';
import ArticleJsonMeta from '../../../baseapp/components/article/article-json-meta';
import ArticleMeta from '../../../baseapp/components/article/ArticleMeta';
import ArticlePageBanner from '../../../baseapp/components/article/ArticlePageBanner';
import CommentSection from '../../../baseapp/components/article/CommentSection';
import Marked from '../../../baseapp/components/article/marked';
import TagList from '../../../baseapp/components/common/TagList';
import Wrapper from '../../../baseapp/components/common/wrapper';
import { ArticleDocument, ArticleQuery, ArticleViewFragment } from '../../generated/graphql';
import { BASE_URL } from '../../lib/constants';
import Custom404 from '../../../baseapp/pages/404';

const ArticlePage = () => {
  const { slug: routeSlug } = useRouter().query;
  const { data, loading } = useArticleQuery({ variables: { slug: String(routeSlug) }, errorPolicy: 'ignore' });
  if (loading) return <LoadingSpinner />;
  const article = data?.article;
  if (!article) return <Custom404 />;
  const { slug, title, description } = article;
  return (
    <Wrapper
      {...{ title, description }}
      openGraph={{
        url: `${BASE_URL}/article/${slug}`,
        title,
        description,
      }}
    >
      <ArticleJsonMeta article={article} />
      <ArticlePageBanner article={article} />

      <div className='container flex flex-wrap flex-col mx-auto mt-8'>
        <div className='w-full'>
          <Marked content={article.body} className='mb-4' />
        </div>
        <TagList outlined tagList={article.tagList} />

        <hr className='my-4' />

        <div className='mt-16 self-center'>
          <ArticleMeta article={article} />
        </div>
      </div>
      <CommentSection article={article} />
    </Wrapper>
  );
};

export default ArticlePage;

