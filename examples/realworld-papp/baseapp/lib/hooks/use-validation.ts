import { AnySchema, object } from 'yup';
import { AuthUser, useCheckUsernameLazyQuery, UserUpdateInput } from '../../generated/graphql';
import { bio, image, username } from '../validation/schema';
import { useMessageHandler } from './use-message';

export function useCheckUser(origin?: AuthUser) {
  const { handleErrors } = useMessageHandler();
  const [checkUsername] = useCheckUsernameLazyQuery({
    onError: (err) => handleErrors({ err, mode: 'alert' }),
  });


  return object<Record<keyof UserUpdateInput, AnySchema>>({
    username: username.test('check-username', 'Username had been taken', async (value) => {
      if (!value || origin?.username === value) return true;
      const { data } = await checkUsername({ variables: { username: value } });
      return data?.checkUsername === null;
    }),
    bio,
    image,
  });
}
